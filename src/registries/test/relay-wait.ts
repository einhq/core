/**
 * Waiting for a relayed event, for the registry conformance suites.
 *
 * Relay delivery is fire-and-forget, and in the PostgreSQL registries a pooled query per event, so
 * a fixed sleep sized for one message is not a sound wait for several arriving over a contended
 * pool. Poll instead, and let the assertion
 * that follows report the real state when the budget runs out.
 */
export async function waitFor(check: () => Promise<boolean>, budgetMs = 3000): Promise<void> {
  const deadline = Date.now() + budgetMs;

  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }

    await new Promise((r) => setTimeout(r, 10));
  }
}
