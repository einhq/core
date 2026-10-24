import { Button, Menu } from '@mantine/core';
import { createContext, type ReactNode, useContext } from 'react';

/**
 * What the selection bar tells the controls in its `actions` slot.
 *
 * `layout`: on a narrow screen the bar folds every action into one menu, so a control that
 * is a button on a desktop has to be a menu item there. `reportError`: the bar has one line
 * for errors, and an action without a dialog of its own has nowhere else to put one. Both
 * come through context so an action stays self-contained: a page still adds it in one line.
 */
export type SelectionBarContextValue = {
  layout: 'bar' | 'menu';
  reportError: (message: string | null) => void;
};

export const SelectionBarContext = createContext<SelectionBarContextValue>({ layout: 'bar', reportError: () => {} });

export const useSelectionBar = () => useContext(SelectionBarContext);

type Props = {
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  color?: string;
  children: ReactNode;
};

/** One selection action, as a button in the bar or an item in the folded menu. */
export function SelectionActionButton({ icon, onClick, disabled, loading, color, children }: Props) {
  const { layout } = useSelectionBar();
  if (layout === 'menu') {
    return (
      <Menu.Item leftSection={icon} onClick={onClick} disabled={disabled || loading} color={color}>
        {children}
      </Menu.Item>
    );
  }
  return (
    <Button size='xs' variant='light' color={color} leftSection={icon} onClick={onClick} disabled={disabled} loading={loading}>
      {children}
    </Button>
  );
}
