const big = (_, v) => (typeof v === 'bigint' ? v.toString() : v);

/** log(msg, fields): plain text for a terminal, one JSON object per line for a daemon's log collector. */
export function makeLogger({ json = false, out = process.stdout, now = () => new Date().toISOString() } = {}) {
  return (msg, fields = {}) => {
    const level = fields.level ?? 'info';
    if (json) out.write(JSON.stringify({ ts: now(), level, msg, ...fields }, big) + '\n');
    else (level === 'error' ? console.error : console.log)(msg);
  };
}
export const textLog = makeLogger();
