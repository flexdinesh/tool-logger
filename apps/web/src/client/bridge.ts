import { call, isMyGo } from "mygo-runtime";
export const desktop = isMyGo;
export async function shellPreferences(): Promise<unknown> {
  const value: unknown = await call("Shell.Preferences");
  if (typeof value !== "string") throw new Error("Shell preferences must be JSON text.");
  return JSON.parse(value);
}
export async function saveShellPreferences(value: unknown): Promise<void> {
  const result: unknown = await call("Shell.SavePreferences", JSON.stringify(value));
  if (result !== undefined && result !== null) throw new Error("Unexpected preferences response.");
}
export async function quit(): Promise<void> {
  const result: unknown = await call("Shell.Quit");
  if (result !== undefined && result !== null) throw new Error("Unexpected Quit response.");
}
