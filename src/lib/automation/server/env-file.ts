const envLinePattern = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export function parseEnvText(text: string) {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = envLinePattern.exec(line);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

export function credentialStatus(text: string, keys?: readonly string[]) {
  const env = parseEnvText(text);
  const selectedKeys = keys ?? Object.keys(env);
  return Object.fromEntries(
    selectedKeys.map((key) => [key, Boolean(env[key]?.trim())]),
  );
}

export function updateEnvText(text: string, updates: Record<string, string>) {
  const remaining = new Set(Object.keys(updates));
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();

  const nextLines = lines.map((line) => {
    const match = envLinePattern.exec(line);
    if (!match) return line;
    const key = match[1];
    if (!remaining.has(key)) return line;
    remaining.delete(key);
    return `${key}=${updates[key]}`;
  });

  for (const key of remaining) nextLines.push(`${key}=${updates[key]}`);
  return `${nextLines.join("\n")}\n`;
}
