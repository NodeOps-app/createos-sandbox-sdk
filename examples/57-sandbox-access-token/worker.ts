/** Worker entry point: receives only a sandbox id and delegated credential. */
import { CreateosSandboxClient } from "createos-sandbox-sdk";

export async function runWorker(
  sandboxId: string,
  token: string,
  message: string,
): Promise<string> {
  const client = new CreateosSandboxClient({ apiKey: token });
  const sandbox = await client.getSandbox(sandboxId);
  const output = await sandbox.runCommand("echo", [message]);
  return output.result.stdout;
}
