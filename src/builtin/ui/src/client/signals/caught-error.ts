import { signal } from '@preact/signals-react';

/**
 * The last error a route's error boundary caught, with React's component stack: which components
 * it was thrown in, by name. React reports it (`onCaughtError`, main.tsx) once the boundary has
 * drawn its error screen, so the screen reads it from here and shows it under the error.
 */
export const caughtError = signal<{ error: unknown; componentStack: string } | null>(null);
