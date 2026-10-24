/**
 * Command Assertion Helpers
 *
 * Provides assertion utilities for testing command results.
 */

import { assertEquals, assertExists } from '@std/assert';
import type { CommandResult } from './shell-client.ts';
import type { ShellClient } from './shell-client.ts';

/**
 * Assert command succeeded
 */
export function assertSuccess(result: CommandResult, message?: string): void {
  assertEquals(result.success, true, message || `Expected success but got error: ${result.error}`);
}

/**
 * Assert command failed
 */
export function assertFailure(result: CommandResult, message?: string): void {
  assertEquals(result.success, false, message || 'Expected failure but command succeeded');
}

/**
 * Assert command failed with specific error message
 */
export function assertErrorContains(result: CommandResult, substring: string): void {
  assertFailure(result);
  assertExists(result.error);
  assertEquals(
    result.error!.includes(substring),
    true,
    `Expected error to contain "${substring}" but got: ${result.error}`,
  );
}

/**
 * Assert JSON result equals expected value
 */
export function assertResultEquals<T>(result: CommandResult, expected: T): void {
  assertSuccess(result);
  assertEquals(result.data, expected);
}

/**
 * Assert JSON result matches partial pattern
 */
export function assertResultMatches(result: CommandResult, pattern: Record<string, unknown>): void {
  assertSuccess(result);
  const data = result.data as Record<string, unknown>;

  for (const [key, value] of Object.entries(pattern)) {
    assertEquals(data[key], value, `Property "${key}" mismatch`);
  }
}

/**
 * Assert result contains items (for array results like ls)
 */
export function assertResultContains(result: CommandResult, items: string[]): void {
  assertSuccess(result);
  const data = result.data as Array<{ name: string }>;
  const names = data.map((d) => d.name);

  for (const item of items) {
    assertEquals(names.includes(item), true, `Expected result to contain "${item}"`);
  }
}

/**
 * Assert result is an array with expected length
 */
export function assertResultLength(result: CommandResult, length: number): void {
  assertSuccess(result);
  const data = result.data as unknown[];
  assertEquals(data.length, length, `Expected ${length} items but got ${data.length}`);
}

/**
 * Helper class for fluent command testing
 */
export class CommandTest {
  constructor(private client: ShellClient) {}

  /**
   * Execute and expect success
   */
  async shouldSucceed(command: string): Promise<CommandResult> {
    const result = await this.client.exec(command);
    assertSuccess(result);
    return result;
  }

  /**
   * Execute and expect failure
   */
  async shouldFail(command: string): Promise<CommandResult> {
    const result = await this.client.exec(command);
    assertFailure(result);
    return result;
  }

  /**
   * Execute and expect specific error
   */
  async shouldFailWith(command: string, errorSubstring: string): Promise<CommandResult> {
    const result = await this.client.exec(command);
    assertErrorContains(result, errorSubstring);
    return result;
  }

  /**
   * Execute and expect result
   */
  async shouldReturn<T>(command: string, expected: T): Promise<CommandResult> {
    const result = await this.client.exec(command);
    assertResultEquals(result, expected);
    return result;
  }

  /**
   * Execute and expect result containing items
   */
  async shouldContain(command: string, items: string[]): Promise<CommandResult> {
    const result = await this.client.exec(command);
    assertResultContains(result, items);
    return result;
  }
}

/**
 * Create command test helper
 */
export function testCommands(client: ShellClient): CommandTest {
  return new CommandTest(client);
}
