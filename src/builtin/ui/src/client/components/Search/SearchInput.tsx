import { ActionIcon, Badge, Group, Loader, Pill, PillsInput, Popover, Text, TextInput, UnstyledButton } from '@mantine/core';
import { IconAlbum, IconArrowRight, IconDeviceCameraPhone, IconMapPin, IconSearch, IconTag, IconUser } from '@tabler/icons-react';
import { type ChangeEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useMentionComplete } from '../../hooks/useMentionComplete.ts';
import { usePhone } from '../../hooks/usePhone.ts';
import { applyCompletion, filtersFromMentions, type Mention, MENTION_KINDS, mentionAtCaret, type MentionKind, parseMentions } from '../../lib/mentions.ts';
import type { SearchFilters } from '../../lib/search-filters.ts';

const KIND_ICON: Record<MentionKind, React.ReactNode> = {
  person: <IconUser size={14} />,
  location: <IconMapPin size={14} />,
  label: <IconTag size={14} />,
  device: <IconDeviceCameraPhone size={14} />,
  album: <IconAlbum size={14} />,
};

export type SearchInputProps = {
  /** The box's text. Owned by the page, so a URL change can rewrite it. */
  value: string;
  onChange: (value: string) => void;
  /**
   * The mentions the page knows about — everything ever picked here, plus
   * whatever `textFromFilters` rebuilt from the URL. Parsing matches against
   * this list, so a mention the page has forgotten degrades to plain text.
   */
  mentions?: readonly Mention[];
  onMentionsChange?: (mentions: Mention[]) => void;
  /** Commit: the filters the box resolved to, and any `@run` that matched nothing. */
  onCommit: (filters: SearchFilters, unresolved: string[]) => void;
  /** The filters already on screen; mentions merge into these rather than replacing them. */
  filters?: SearchFilters;
  /** Which kinds an `@` may resolve to here. The map has no use for an album. */
  kinds?: readonly MentionKind[];
  placeholder?: string;
  /**
   * What the box says on a phone, where it shares a header line with the choice
   * button and the long placeholder shows only its first few words.
   */
  shortPlaceholder?: string;
  size?: string;
  /** Rendered inside the box on the left. Pass null when the search action already identifies it. */
  leftSection?: React.ReactNode;
  /** Rendered inside the box on the right — a loader, a filter button. */
  rightSection?: React.ReactNode;
  /** Resolved filters rendered before the editable text inside a compound input. */
  pills?: React.ReactNode;
  /** Icon used by the default commit button; an arrow, the same on every page, unless a page says otherwise. */
  submitIcon?: React.ReactNode;
  autoFocus?: boolean;
};

/**
 * The search box, shared by every page that searches.
 *
 * Typing `@` opens a list of people, locations, labels, devices and albums;
 * picking one writes `@Their Name` into the text and remembers what it resolved
 * to. Committing splits the two apart — see `lib/mentions.ts`, which owns that
 * codec and is where the round trip is tested.
 *
 * Every page gets the `@` completion. A page that also reads the words as natural language
 * (`useSearchBox` with `natural`) gets the text left after the mentions, and turns what it
 * understood into the same chips (`SearchPills`) an `@` pick becomes.
 *
 * A plain `TextInput`, not a rich editor: the mention labels contain spaces and
 * live in the string as ordinary text, which keeps selection, undo and the
 * caret behaving the way a text box should.
 */
export function SearchInput({
  value,
  onChange,
  mentions = [],
  onMentionsChange,
  onCommit,
  filters = {},
  kinds = MENTION_KINDS,
  placeholder: fullPlaceholder = 'Search — type @ for a person, location, label or device',
  shortPlaceholder = 'Search…',
  size = 'md',
  leftSection = <IconSearch size={18} />,
  rightSection,
  pills,
  submitIcon = <IconArrowRight size={size === 'sm' ? 16 : 18} />,
  autoFocus,
}: SearchInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const placeholder = usePhone() ? shortPlaceholder : fullPlaceholder;
  const [highlighted, setHighlighted] = useState(0);
  /** Set by Escape; cleared as soon as the run changes, so `@` works again immediately. */
  const [dismissed, setDismissed] = useState<string | null>(null);

  /** The popup belongs to the box: clicking anywhere else closes it. */
  const [focused, setFocused] = useState(Boolean(autoFocus));

  const run = mentionAtCaret(value, caret);
  // A run that begins with a finished pick (`@Anna Andersson ` and the caret
  // past it) is not being typed any more; completing on it again would reopen
  // the list the pick just closed.
  const completed = run !== undefined && mentions.some((known) => run.query.startsWith(`${known.label} `));
  const open = focused && run !== undefined && !completed && dismissed !== run.query;

  const { suggestions, loading } = useMentionComplete(open ? run.query : undefined, kinds);

  useEffect(() => setHighlighted(0), [suggestions.length, run?.query]);

  const choose = useCallback((mention: Mention) => {
    if (!run) return;
    const next = applyCompletion(value, caret, run, mention);
    onChange(next.text);
    // Remembered whether or not it survives to the commit: the label is how the
    // text is matched back to this entity later.
    onMentionsChange?.([...mentions.filter((known) => !(known.kind === mention.kind && known.value === mention.value)), mention]);
    setDismissed(null);
    // After the state has landed, or the DOM value is still the old one.
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  }, [run, value, caret, mentions, onChange, onMentionsChange]);

  const commit = useCallback(() => {
    const parsed = parseMentions(value, mentions);
    onCommit(filtersFromMentions(filters, parsed), parsed.unresolved);
  }, [value, mentions, filters, onCommit]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (open && suggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlighted((index) => (index + 1) % suggestions.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlighted((index) => (index - 1 + suggestions.length) % suggestions.length);
        return;
      }
      // Enter picks the highlighted suggestion rather than searching: the run is
      // half-typed, so searching it is never what was meant.
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        choose(suggestions[highlighted]);
        return;
      }
    }

    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setDismissed(run?.query ?? '');
      return;
    }

    if (event.key === 'Enter') commit();
  };

  // The caret moves for reasons that are not keystrokes — a click, a drag, an
  // arrow key — and the open run is a function of where it is.
  const syncCaret = () => setCaret(inputRef.current?.selectionStart ?? 0);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(event.currentTarget.value);
    setDismissed(null);
    setCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
  };

  const commitButton = rightSection ?? (
    <ActionIcon variant='subtle' size='lg' aria-label='Search' onClick={commit}>
      {submitIcon}
    </ActionIcon>
  );

  const input = pills
    ? (
      <PillsInput size={size} leftSection={leftSection} rightSection={commitButton}>
        <Pill.Group>
          {pills}
          <PillsInput.Field
            ref={inputRef}
            value={value}
            autoFocus={autoFocus}
            placeholder={placeholder}
            onChange={handleChange}
            onKeyUp={syncCaret}
            onClick={syncCaret}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={onKeyDown}
          />
        </Pill.Group>
      </PillsInput>
    )
    : (
      <TextInput
        ref={inputRef}
        value={value}
        size={size}
        autoFocus={autoFocus}
        placeholder={placeholder}
        leftSection={leftSection}
        rightSection={commitButton}
        onChange={handleChange}
        onKeyUp={syncCaret}
        onClick={syncCaret}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
      />
    );

  return (
    <Popover opened={open && (suggestions.length > 0 || loading)} position='bottom-start' width='target' shadow='lg'>
      <Popover.Target>
        {input}
      </Popover.Target>

      <Popover.Dropdown p={4}>
        {suggestions.length === 0 && loading
          ? (
            <Group p='xs' gap='xs'>
              <Loader size={14} />
              <Text size='sm' c='dimmed'>Looking…</Text>
            </Group>
          )
          : suggestions.map((mention, index) => (
            <UnstyledButton
              key={`${mention.kind}:${mention.value}`}
              p='xs'
              w='100%'
              className='mrx-hover-row'
              style={{
                borderRadius: 'var(--mantine-radius-sm)',
                background: index === highlighted ? 'var(--mrx-surface-raised)' : undefined,
              }}
              onMouseEnter={() => setHighlighted(index)}
              // `onMouseDown`, not `onClick`: a click blurs the input first, and
              // the blur closes the popup before the click can land.
              onMouseDown={(event) => {
                event.preventDefault();
                choose(mention);
              }}
            >
              <Group gap='sm' wrap='nowrap'>
                {KIND_ICON[mention.kind]}
                <Text size='sm' truncate style={{ flex: 1, minWidth: 0 }}>{mention.label}</Text>
                <Badge size='xs' variant='light'>{mention.kind}</Badge>
              </Group>
            </UnstyledButton>
          ))}
      </Popover.Dropdown>
    </Popover>
  );
}
