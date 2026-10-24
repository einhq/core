import { createContext, useContext } from 'react';

/**
 * How a card inside a `CardGrid` says it needs more height than the grid gave it.
 *
 * The grid reserves what its items' data says the cards draw
 * (`CardGridProps.textParts`); what it cannot know is how a line of badges
 * wraps at a given card width. A card whose content overflows reports its
 * natural height, in px, and the grid grows every card to the tallest reported.
 * Outside a grid there is nothing to report to.
 */
const CardFitContext = createContext<((naturalHeight: number) => void) | undefined>(undefined);

export const CardFitProvider = CardFitContext.Provider;

export function useCardFit(): ((naturalHeight: number) => void) | undefined {
  return useContext(CardFitContext);
}
