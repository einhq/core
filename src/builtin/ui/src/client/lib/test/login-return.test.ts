import { assertEquals } from '@std/assert';
import { loginReturnPath, loginUrlFor } from '../login-return.ts';

const returnFrom = (url: string) => loginReturnPath(new URL(url, 'http://ein.test').searchParams);

Deno.test('login return: the page a visitor was sent from survives the round trip', () => {
  for (const path of ['/albums/Sommar', '/search?q=a%20sailboat&type=image', '/people/anna#family', '/map?lat=59.3&lng=-18.1']) {
    assertEquals(returnFrom(loginUrlFor(path)), path);
  }
});

Deno.test('login return: the dashboard needs no next parameter', () => {
  assertEquals(loginUrlFor('/'), '/login');
  assertEquals(returnFrom('/login'), '/');
});

Deno.test('login return: a next that leaves the site or loops back to login goes to the dashboard', () => {
  for (const next of ['https://evil.example/', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', 'albums', '', '/login', '/login?next=/x']) {
    assertEquals(returnFrom(`/login?next=${encodeURIComponent(next)}`), '/', next);
  }
});
