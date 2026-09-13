export function duration(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export const clock = (date: string | number) =>
  new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export const number = (value: number) => value.toLocaleString();

export function repositoryName(root: string | null): string {
  if (!root) return "";
  return root.split("/").filter(Boolean).at(-1) ?? root;
}

export function repositoryLabel(root: string, roots: string[]): string {
  const name = repositoryName(root);
  const duplicate = roots.some((other) => other !== root && repositoryName(other) === name);
  return duplicate ? `${name} — ${root}` : name;
}
