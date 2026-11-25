import { Box, Flex, Paper, Stack } from '@mantine/core';
import { HatField } from '../components/EntityDetail/HatField.tsx';
import { LoginForm } from '../components/Login/LoginForm.tsx';
import { AdminNotice } from '../components/Notice/AdminNotice.tsx';

/**
 * The login form centred over the headers' einstein-hat field, so the first screen already looks like
 * the rest of EiN. The archive's own media is behind auth and cannot be used here, and a remote stock
 * photo would be a network request and someone else's life; the pattern is local and works offline.
 * Under the form, the administrator's note, when there is one.
 */
export default function LoginPage() {
  return (
    <Flex
      className='mrx-pattern'
      data-pattern='mixed'
      h='100vh'
      w='100vw'
      justify='center'
      align='center'
      p='xl'
    >
      <Box pos='absolute' inset={0}>
        <HatField pattern='mixed' kind='backdrop' />
      </Box>
      {/* Positioned like the field before it, so it is drawn over the field and a link in it takes the click. */}
      <Paper withBorder p='xl' radius='md' w='100%' maw={420} pos='relative'>
        <Stack gap='lg'>
          <LoginForm />
          <AdminNotice />
        </Stack>
      </Paper>
    </Flex>
  );
}
