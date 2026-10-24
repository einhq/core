type ActionType =
  | 'nop'
  | 'insert'
  | 'delete'
  | 'backspace'
  | 'moveLeft'
  | 'moveRight'
  | 'moveUp'
  | 'moveDown'
  | 'moveHome'
  | 'moveEnd'
  | 'interrupt'
  | 'exit'
  | 'lf'
  | 'cr'
  | 'escape'
  | 'tab'
  | 'reverseSearch';

export type Action = {
  type: ActionType;
  data?: string;
};

const ansiCodeToAction = (code: string): Action => {
  switch (code) {
    case '\x1b[A': // Up
      return { type: 'moveUp' };
    case '\x1b[B': // Down
      return { type: 'moveDown' };
    case '\x1b[C':
      return { type: 'moveRight' };
    case '\x1b[D':
      return { type: 'moveLeft' };
    case '\x1b[H':
      return { type: 'moveHome' };
    case '\x1b[F':
      return { type: 'moveEnd' };
  }

  return { type: 'nop' };
};

export const identifyActions = (input: string) => {
  const actions: Action[] = [];

  for (let n = 0; n < input.length; n++) {
    const char = input[n];

    if (char === '\x12') {
      actions.push({ type: 'reverseSearch' });
    } else if (char === '\x03') {
      actions.push({ type: 'interrupt' });
    } else if (char === '\x04') {
      actions.push({ type: 'exit' });
    } else if (char === '\x0a') {
      actions.push({ type: 'lf' });
    } else if (char === '\x0d') {
      actions.push({ type: 'cr' });
    } else if (char === '\x7f') {
      actions.push({ type: 'backspace' });
    } else if (char === '\x7e') {
      actions.push({ type: 'delete' });
    } else if (char === '\t') {
      actions.push({ type: 'tab' });
    } else if (char === '\x1b') {
      const code = input.slice(n, n + 3);

      if (code.length === 1) {
        actions.push({ type: 'escape' });
      } else {
        n += 2;
        actions.push(ansiCodeToAction(code));
      }
    } else {
      actions.push({ type: 'insert', data: char });
    }
  }

  return actions;
};
