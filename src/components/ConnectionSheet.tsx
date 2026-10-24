import { useEffect, useRef, useState } from "react";
import { api, pickKeyFile } from "../api";
import { parseConnectionUrl } from "../lib/sql";
import { useApp } from "../store";
import type {
  AppError,
  ConnectionProfile,
  Engine,
  NetworkMode,
  SecretField,
  SecretsInput,
  SshAuth,
  SshHop,
  SslMode,
  TestReport,
} from "../types";
import { envColors, useDarkMode } from "../lib/theme";
import { openMenuBelow, type MenuItem } from "./ContextMenu";
import { EngineBadge, IconCheck, IconEye, IconEyeOff, IconPlus } from "./Icons";
import { ReplaceHostKey } from "./ReplaceHostKey";
import { exact } from "../lib/input";

const uid = () => crypto.randomUUID();

function blankProfile(engine: Engine): ConnectionProfile {
  return {
    id: uid(),
    name: "",
    engine,
    environment: "local",
    host: "localhost",
    port: engine === "postgres" ? 5432 : 3306,
    user: engine === "postgres" ? "postgres" : "root",
    database: "",
    sslMode: "prefer",
    network: { mode: "direct", hops: [] },
    confirmWrites: true,
    readOnly: false,
  };
}

const ONE_PASSWORD_AGENT = "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock";

/**
 * A password field with a show / hide button. Passwords are saved encrypted in 1Client, and a saved one
 * reaches the form only when the eye is clicked (`reveal`). A pasted 1Password reference
 * (op://vault/item/field) isn't a secret: it is always shown, and read from 1Password on connect.
 */
function SecretInput({
  value,
  onChange,
  reveal,
  inputClass,
  placeholder = "Password",
  title,
  width,
}: {
  value: string | undefined;
  onChange: (value: string) => void;
  /** Set when editing a saved connection: fetches the saved value, or null when there is none. */
  reveal?: () => Promise<string | null>;
  inputClass: string;
  placeholder?: string;
  title?: string;
  width?: number;
}) {
  const [visible, setVisible] = useState(false);
  const [nothingSaved, setNothingSaved] = useState(false);
  const isRef = !!value?.startsWith("op://");

  const toggle = async () => {
    // Nothing typed yet: show what is saved, if anything.
    if (!visible && value === undefined && reveal) {
      const saved = await reveal().catch(() => null);
      if (saved === null) setNothingSaved(true);
      else onChange(saved);
    }
    setVisible(!visible);
  };

  return (
    <span className={`secret-field ${width ? "" : "grow"}`} style={width ? { width } : undefined}>
      <input
        {...exact}
        type={visible || isRef ? "text" : "password"}
        className={`${inputClass} ${isRef ? "mono" : ""}`}
        autoComplete="off"
        title={title}
        placeholder={nothingSaved ? "Nothing saved" : reveal ? "Saved (type to change)" : placeholder}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
      />
      {!isRef && (
        <button
          type="button"
          className="secret-eye"
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          title={visible ? "Hide" : "Show"}
          onClick={toggle}
        >
          {visible ? <IconEyeOff /> : <IconEye />}
        </button>
      )}
    </span>
  );
}

const newHop = (): SshHop => ({ id: uid(), host: "", port: 22, user: "", auth: { kind: "agent" } });

type Test = { state: "idle" } | { state: "testing" } | { state: "ok"; report: TestReport } | { state: "error"; error: AppError };

export function ConnectionSheet() {
  const { sheet, setSheet, loadProfiles, openConnection, environments, setEnvSheet } = useApp();
  const dark = useDarkMode();
  const editing = sheet?.mode === "edit" ? sheet.profile : null;

  const [step, setStep] = useState<"pick" | "details">(editing ? "details" : "pick");
  const [p, setP] = useState<ConnectionProfile>(() => (editing ? structuredClone(editing) : blankProfile("postgres")));
  const [secrets, setSecrets] = useState<SecretsInput>({ hops: {} });
  const [url, setUrl] = useState("");
  const [test, setTest] = useState<Test>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  // Show saved 1Password references when editing (they are not secret; passwords never come back).
  useEffect(() => {
    if (editing) api.secretReferences(editing.id).then((refs) => setSecrets({ hops: {}, ...refs }), () => {});
  }, [editing]);

  if (!sheet) return null;
  /** Fetches a saved secret for the show-password button (only for saved connections). */
  const revealer = (field: SecretField) => (editing ? () => api.revealSecret(editing.id, field) : undefined);

  const update = (patch: Partial<ConnectionProfile>) => {
    setP((cur) => ({ ...cur, ...patch }));
    setTest({ state: "idle" });
  };
  const setEngine = (engine: Engine) =>
    update({ engine, port: p.port === 5432 || p.port === 3306 ? (engine === "postgres" ? 5432 : 3306) : p.port });

  const setMode = (mode: NetworkMode) => {
    const hops = mode === "direct" || p.network.hops.length ? p.network.hops : [newHop()];
    update({ network: { mode, hops } });
  };
  const visibleHops = p.network.mode === "direct" ? [] : p.network.mode === "sshTunnel" ? p.network.hops.slice(0, 1) : p.network.hops;
  const setHop = (id: string, patch: Partial<SshHop>) =>
    update({ network: { ...p.network, hops: p.network.hops.map((h) => (h.id === id ? { ...h, ...patch } : h)) } });
  const moveHop = (i: number, dir: -1 | 1) => {
    const hops = [...p.network.hops];
    const j = i + dir;
    if (j < 0 || j >= hops.length) return;
    [hops[i], hops[j]] = [hops[j], hops[i]];
    update({ network: { ...p.network, hops } });
  };
  const hopSecret = (id: string, patch: { password?: string; keyPassphrase?: string }) =>
    setSecrets((s) => ({ ...s, hops: { ...s.hops, [id]: { ...s.hops?.[id], ...patch } } }));

  const applyUrl = () => {
    const parsed = parseConnectionUrl(url);
    if (!parsed) return;
    setP((cur) => ({ ...cur, ...parsed.profile }) as ConnectionProfile);
    if (parsed.password) setSecrets((s) => ({ ...s, dbPassword: parsed.password }));
    setStep("details");
  };

  const finalProfile = (): ConnectionProfile => ({
    ...p,
    name: p.name.trim() || p.host,
    network: { ...p.network, hops: p.network.mode === "sshTunnel" ? p.network.hops.slice(0, 1) : p.network.hops },
  });

  const runTest = async () => {
    setTest({ state: "testing" });
    try {
      setTest({ state: "ok", report: await api.testConnection(finalProfile(), secrets) });
    } catch (e) {
      setTest({ state: "error", error: e as AppError });
    }
  };

  /** List the server's databases with what is filled in, and pick one. */
  const browse = async (button: HTMLElement) => {
    if (browsing) return;
    setBrowsing(true);
    try {
      const names = await api.listDatabases(finalProfile(), secrets);
      const items: MenuItem[] = names.length
        ? names.map((n) => ({ label: n, checked: n === p.database, action: () => update({ database: n }) }))
        : [{ label: "No databases you can open", disabled: true, action: () => {} }];
      openMenuBelow(button, items, names.length > 10);
    } catch (e) {
      setTest({ state: "error", error: e as AppError });
    } finally {
      setBrowsing(false);
    }
  };

  const save = async (connect: boolean) => {
    setBusy(true);
    try {
      const saved = await api.saveConnection(finalProfile(), secrets);
      await loadProfiles();
      setSheet(null);
      if (connect) await openConnection(saved.id);
    } catch (e) {
      setTest({ state: "error", error: e as AppError });
    } finally {
      setBusy(false);
    }
  };

  const route = [
    { label: "This Mac", sub: "localhost", kind: "mac" },
    ...visibleHops.map((h, i) => ({ label: h.host || `hop ${i + 1}`, sub: `:${h.port}`, kind: "ssh" })),
    { label: p.host || "database", sub: `:${p.port}`, kind: "db" },
  ];

  return (
    // A click next to the sheet doesn't close it: that would lose what was typed. Escape is Cancel.
    <div className="sheet-backdrop" onKeyDown={(e) => e.key === "Escape" && !e.defaultPrevented && setSheet(null)}>
      {step === "pick" ? (
        <div className="sheet" style={{ width: 720 }}>
          <div className="sheet-head center">
            <div className="sheet-title">New Connection</div>
          </div>
          <div className="engine-cards">
            {(["postgres", "mysql"] as Engine[]).map((e) => (
              <button key={e} className={`engine-card ${p.engine === e ? "on" : ""}`} onClick={() => setEngine(e)}>
                <EngineBadge engine={e} size={48} />
                <span className="engine-card-name">{e === "postgres" ? "PostgreSQL" : "MySQL"}</span>
                <span className="muted">
                  {e === "postgres"
                    ? "Versions 12 and newer. Schemas, enums, JSONB and arrays."
                    : "MySQL 5.7, 8.x and MariaDB. Works with managed hosts like RDS."}
                </span>
                {p.engine === e && (
                  <span className="engine-card-check">
                    <IconCheck color="#fff" />
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="sheet-body">
            <label className="field-label" htmlFor="conn-url">
              Or paste a connection URL
            </label>
            <input
              {...exact}
              id="conn-url"
              className="text-field mono"
              placeholder={p.engine === "postgres" ? "postgres://user@host:5432/database" : "mysql://user@host:3306/database"}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyUrl()}
            />
            <div className="muted small">Host, port, user and database are filled in. Passwords are saved encrypted in 1Client.</div>
          </div>
          <div className="sheet-foot">
            <div className="grow" />
            <button className="btn" onClick={() => setSheet(null)}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => (url.trim() ? applyUrl() : setStep("details"))}>
              Continue
            </button>
          </div>
        </div>
      ) : (
        <div className="sheet details" style={{ width: 1040 }}>
          <div className="sheet-head">
            <EngineBadge engine={p.engine} size={40} />
            <div className="grow">
              <input
                {...exact}
                className="title-input"
                aria-label="Connection name"
                placeholder="Connection name"
                value={p.name}
                onChange={(e) => update({ name: e.target.value })}
              />
              <div className="muted small">{p.engine === "postgres" ? "PostgreSQL" : "MySQL"}</div>
            </div>
            <Segmented
              value={p.engine}
              options={[
                ["postgres", "PostgreSQL"],
                ["mysql", "MySQL"],
              ]}
              onChange={(v) => setEngine(v as Engine)}
            />
          </div>

          <div className="sheet-scroll">
            <div className="sheet-grid">
              <div className="col">
                <Group title="Server">
                  <Row label="Host">
                    <input {...exact} className="row-input" value={p.host} onChange={(e) => update({ host: e.target.value })} />
                    <span className="muted">:</span>
                    <input
                      {...exact}
                      className="row-input port"
                      aria-label="Port"
                      value={p.port}
                      onChange={(e) => update({ port: Number(e.target.value.replace(/\D/g, "")) || 0 })}
                    />
                  </Row>
                  <Row label="User">
                    <input {...exact} className="row-input" value={p.user} onChange={(e) => update({ user: e.target.value })} />
                  </Row>
                  <Row label="Password">
                    <SecretInput
                      inputClass="row-input"
                      title="Password, or a 1Password reference (op://vault/item/field)"
                      value={secrets.dbPassword}
                      onChange={(dbPassword) => setSecrets((s) => ({ ...s, dbPassword }))}
                      reveal={revealer({ kind: "db" })}
                    />
                  </Row>
                  <Row label="Database">
                    <input
                      {...exact}
                      className="row-input"
                      placeholder={p.engine === "postgres" ? "postgres" : "optional"}
                      value={p.database}
                      onChange={(e) => update({ database: e.target.value })}
                    />
                    <button
                      type="button"
                      className="btn tiny"
                      title="Connect with these settings and list the databases"
                      aria-busy={browsing}
                      onClick={(e) => browse(e.currentTarget)}
                    >
                      {browsing ? "Listing…" : "Browse…"}
                    </button>
                  </Row>
                  <Row label={p.engine === "postgres" ? "SSL mode" : "SSL"} last>
                    <select className="popup" value={p.sslMode} onChange={(e) => update({ sslMode: e.target.value as SslMode })}>
                      <option value="disable">Disable</option>
                      <option value="prefer">Prefer</option>
                      <option value="require">Require</option>
                      <option value="verifyFull">Verify certificate</option>
                    </select>
                  </Row>
                </Group>

                <Group title="Safety">
                  <Row label="Environment">
                    <div className="env-chips">
                      {environments.map((env) => {
                        const on = p.environment === env.id;
                        const c = envColors(env.color, dark);
                        return (
                          <button
                            key={env.id}
                            className={`env-chip ${on ? "on" : ""}`}
                            style={on ? { color: c.fg, background: c.bg, borderColor: "transparent" } : undefined}
                            onClick={(e) => {
                              e.preventDefault();
                              update({ environment: env.id, confirmWrites: env.confirmWrites || p.confirmWrites });
                            }}
                          >
                            <span className="env-dot" style={{ background: env.color }} />
                            {env.name}
                          </button>
                        );
                      })}
                      <button
                        className="link-btn"
                        onClick={(e) => {
                          e.preventDefault();
                          setEnvSheet(true);
                        }}
                      >
                        Edit…
                      </button>
                    </div>
                  </Row>
                  <Row label="Ask before running writes">
                    <Switch on={p.confirmWrites} onChange={(v) => update({ confirmWrites: v })} label="Ask before running writes" />
                  </Row>
                  <Row label="Read-only session" last>
                    <Switch on={p.readOnly} onChange={(v) => update({ readOnly: v })} label="Read-only session" />
                  </Row>
                </Group>
              </div>

              <div className="col">
                <div className="group-title">Connect via</div>
                <div className="group padded">
                  <Segmented
                    stretch
                    value={p.network.mode}
                    options={[
                      ["direct", "Direct"],
                      ["sshTunnel", "SSH Tunnel"],
                      ["bastion", "Bastion Host"],
                    ]}
                    onChange={(v) => setMode(v as NetworkMode)}
                  />

                  <div className="route">
                    {route.map((n, i) => (
                      <div key={i} className="route-step">
                        {i > 0 && <div className="route-arrow" />}
                        <div className="route-node">
                          <span className={`route-icon ${n.kind} ${n.kind === "db" ? `engine-${p.engine}` : ""}`}>
                            {n.kind === "mac" ? "Mac" : n.kind === "ssh" ? "SSH" : p.engine === "postgres" ? "PG" : "My"}
                          </span>
                          <span className="route-label ellipsis">{n.label}</span>
                          <span className="route-sub mono">{n.sub}</span>
                        </div>
                      </div>
                    ))}
                  </div>

                  {p.network.mode === "direct" && (
                    <div className="muted">1Client connects straight to the database host. Use this for local databases or hosts open to your network.</div>
                  )}

                  {visibleHops.map((h, i) => (
                    <div key={h.id} className="hop">
                      <div className="hop-head">
                        <span className="hop-role">
                          {p.network.mode === "sshTunnel"
                            ? "SSH SERVER"
                            : i === 0
                              ? "HOP 1 · BASTION"
                              : `HOP ${i + 1}${i === visibleHops.length - 1 ? " · FORWARDS TO DATABASE" : ""}`}
                        </span>
                        <span className="grow" />
                        {p.network.mode === "bastion" && (
                          <div className="row gap4">
                            <button className="btn tiny" aria-label="Move up" disabled={i === 0} onClick={() => moveHop(i, -1)}>
                              ↑
                            </button>
                            <button
                              className="btn tiny"
                              aria-label="Move down"
                              disabled={i === visibleHops.length - 1}
                              onClick={() => moveHop(i, 1)}
                            >
                              ↓
                            </button>
                            <button
                              className="btn tiny"
                              disabled={visibleHops.length === 1}
                              onClick={() => update({ network: { ...p.network, hops: p.network.hops.filter((x) => x.id !== h.id) } })}
                            >
                              Remove
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="hop-grid">
                        <label>
                          <span>User</span>
                          <input {...exact} className="fill-field mono" value={h.user} onChange={(e) => setHop(h.id, { user: e.target.value })} />
                        </label>
                        <label>
                          <span>Host</span>
                          <input {...exact} className="fill-field mono" value={h.host} onChange={(e) => setHop(h.id, { host: e.target.value })} />
                        </label>
                        <label>
                          <span>Port</span>
                          <input
                            {...exact}
                            className="fill-field mono"
                            value={h.port}
                            onChange={(e) => setHop(h.id, { port: Number(e.target.value.replace(/\D/g, "")) || 0 })}
                          />
                        </label>
                      </div>
                      <div className="hop-auth">
                        <span className="muted small">Sign in with</span>
                        <select
                          className="popup"
                          value={h.auth.kind}
                          onChange={(e) => {
                            const kind = e.target.value as SshAuth["kind"];
                            const auth: SshAuth =
                              kind === "keyFile" ? { kind, path: "~/.ssh/id_ed25519" } : kind === "agent" ? { kind } : { kind };
                            setHop(h.id, { auth });
                          }}
                        >
                          <option value="agent">SSH agent</option>
                          <option value="keyFile">SSH key</option>
                          <option value="password">Password</option>
                        </select>
                        {h.auth.kind === "keyFile" && (
                          <>
                            <input
                              {...exact}
                              className="fill-field mono grow"
                              value={h.auth.path}
                              onChange={(e) => setHop(h.id, { auth: { kind: "keyFile", path: e.target.value } })}
                            />
                            <button
                              className="btn small"
                              onClick={async () => {
                                const path = await pickKeyFile();
                                if (path) setHop(h.id, { auth: { kind: "keyFile", path } });
                              }}
                            >
                              Choose…
                            </button>
                            <SecretInput
                              inputClass="fill-field"
                              placeholder="Passphrase"
                              width={secrets.hops?.[h.id]?.keyPassphrase?.startsWith("op://") ? 240 : 210}
                              value={secrets.hops?.[h.id]?.keyPassphrase}
                              onChange={(keyPassphrase) => hopSecret(h.id, { keyPassphrase })}
                              reveal={revealer({ kind: "hopPassphrase", hopId: h.id })}
                            />
                          </>
                        )}
                        {h.auth.kind === "agent" && (
                          <input
                            {...exact}
                            className="fill-field mono grow"
                            placeholder="Agent socket (default: SSH_AUTH_SOCK)"
                            value={h.auth.socket ?? ""}
                            onChange={(e) => setHop(h.id, { auth: { kind: "agent", socket: e.target.value || null } })}
                          />
                        )}
                        {h.auth.kind === "agent" && h.auth.socket !== ONE_PASSWORD_AGENT && (
                          <button
                            className="link-btn"
                            title="Use the SSH agent built into 1Password"
                            onClick={() => setHop(h.id, { auth: { kind: "agent", socket: ONE_PASSWORD_AGENT } })}
                          >
                            Use 1Password
                          </button>
                        )}
                        {h.auth.kind === "password" && (
                          <SecretInput
                            inputClass="fill-field"
                            value={secrets.hops?.[h.id]?.password}
                            onChange={(password) => hopSecret(h.id, { password })}
                            reveal={revealer({ kind: "hopPassword", hopId: h.id })}
                          />
                        )}
                      </div>
                    </div>
                  ))}

                  {p.network.mode === "bastion" && (
                    <button className="add-hop" onClick={() => update({ network: { ...p.network, hops: [...p.network.hops, newHop()] } })}>
                      <IconPlus color="var(--accent)" /> Add jump host
                    </button>
                  )}
                </div>
              </div>
            </div>

            {test.state === "ok" && <TestSteps key={test.report.elapsedMs} report={test.report} onRetry={runTest} />}
          </div>

          <div className="sheet-foot">
            <TestStatus test={test} />
            <button className="btn" onClick={runTest} disabled={test.state === "testing"}>
              Test Connection
            </button>
            {editing ? (
              <button className="btn" onClick={() => setSheet(null)}>
                Cancel
              </button>
            ) : (
              <button className="btn" onClick={() => setStep("pick")}>
                Back
              </button>
            )}
            <button className="btn" onClick={() => save(false)} disabled={busy}>
              Save
            </button>
            <button className="btn primary" onClick={() => save(true)} disabled={busy}>
              Save and Connect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TestStatus({ test }: { test: Test }) {
  if (test.state === "idle") return <div className="grow muted">Not tested yet</div>;
  if (test.state === "testing") return <div className="grow muted">Testing…</div>;
  if (test.state === "error")
    return (
      <div className="grow row gap8 min0">
        <span className="dot err" />
        <span className="ellipsis" title={test.error.message}>
          {test.error.message}
        </span>
      </div>
    );
  const r = test.report;
  if (r.ok)
    return (
      <div className="grow row gap8">
        <span className="dot ok" />
        {r.hops ? `Tunnel up through ${r.hops} hop${r.hops > 1 ? "s" : ""}, ` : ""}
        {r.serverVersion} answered in {r.elapsedMs} ms
      </div>
    );
  const failed = r.steps.find((s) => s.status === "failed");
  return (
    <div className="grow row gap8 min0">
      <span className="dot err" />
      <span className="ellipsis">Failed at: {failed?.label ?? "connecting"}</span>
    </div>
  );
}

/** Every step of the test: what worked, what failed (with a hint), and what was not tried. */
function TestSteps({ report, onRetry }: { report: TestReport; onRetry: () => void }) {
  const [showPassed, setShowPassed] = useState(false);
  const ref = useRef<HTMLOListElement>(null);
  // Braces matter: newer engines return a Promise from scroll methods, and an effect may only return a cleanup.
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);
  const passed = report.steps.filter((s) => s.status === "ok").length;
  const visible = report.steps.filter((s) => showPassed || s.status !== "ok");
  return (
    <ol ref={ref} className={`test-steps ${report.ok ? "ok" : "failed"}`} aria-label="Connection test steps">
      {passed > 0 && (
        <li className="test-step ok">
          <span className="test-icon">✓</span>
          <div className="row gap8">
            <span className="test-label">
              {passed} of {report.steps.length} steps passed
            </span>
            <button className="link-btn" onClick={() => setShowPassed((v) => !v)}>
              {showPassed ? "Hide" : "Show"}
            </button>
          </div>
        </li>
      )}
      {visible.map((s, i) => (
        <li key={i} className={`test-step ${s.status}`}>
          <span className="test-icon" aria-label={s.status}>
            {s.status === "ok" ? "✓" : s.status === "failed" ? "✕" : ""}
          </span>
          <div className="min0 grow">
            <div className="row gap8">
              <span className="test-label">{s.label}</span>
              {s.status === "ok" && s.detail && <span className="muted small">{s.detail}</span>}
              {s.status === "skipped" && <span className="muted small">not tried</span>}
              {s.ms != null && s.status !== "skipped" && <span className="muted tiny-text">{s.ms} ms</span>}
            </div>
            {s.status === "failed" && (
              <>
                {s.detail && <div className="test-detail">{s.detail}</div>}
                {s.hint && <div className="test-hint">{s.hint}</div>}
                {report.error && <ReplaceHostKey error={report.error} onReplaced={onRetry} />}
              </>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Group({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="group-wrap">
      <div className="group-title">{title}</div>
      <div className="group">{children}</div>
      {note && <div className="group-note">{note}</div>}
    </div>
  );
}

function Row({ label, children, last }: { label: string; children: React.ReactNode; last?: boolean }) {
  return (
    <label className={`form-row ${last ? "last" : ""}`}>
      <span className="form-label">{label}</span>
      <span className="form-value">{children}</span>
    </label>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`switch ${on ? "on" : ""}`}
      onClick={(e) => (e.preventDefault(), onChange(!on))}
    >
      <span />
    </button>
  );
}

export function Segmented({
  value,
  options,
  onChange,
  stretch,
}: {
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
  stretch?: boolean;
}) {
  return (
    <div className={`segmented ${stretch ? "stretch" : ""}`} role="tablist">
      {options.map(([v, label]) => (
        <button key={v} role="tab" aria-selected={v === value} className={v === value ? "on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}
