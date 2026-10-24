import { Button, Notification, Portal, Progress, Stack } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { dismissToast, toasts } from '../../signals/notify.ts';

/** The toasts `notify` and `notifyProgress` raise, stacked at the foot of the screen above everything else; a progress toast has its bar. */
export function ToastHost() {
  useSignals();
  const showing = toasts.value;
  if (showing.length === 0) return null;

  return (
    <Portal>
      <Stack className='mrx-toasts' gap='xs' role='status' aria-live='polite'>
        {showing.map((toast) => (
          <Notification
            key={toast.id}
            color={toast.color ?? 'blue'}
            withBorder
            onClose={() => dismissToast(toast.id)}
            className='mrx-toast'
          >
            {toast.message}
            {toast.action && (
              <Button variant='subtle' size='compact-sm' ml='sm' onClick={toast.action.onClick}>
                {toast.action.label}
              </Button>
            )}
            {toast.progress !== undefined && <Progress value={Math.round(toast.progress * 100)} size='sm' mt={8} aria-label='Progress' />}
          </Notification>
        ))}
      </Stack>
    </Portal>
  );
}
