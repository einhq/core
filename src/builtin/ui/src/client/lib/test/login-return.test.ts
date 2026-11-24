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

Deno.test('login return: a next the browser would read as another site goes to the dashboard', () => {
  // The URL parser drops tabs and newlines and reads `\` as `/`; dot segments can leave `//` behind.
  for (const next of ['/\t/evil.example', '/\n/evil.example', '/\r\\evil.example', '/\t\\evil.example', '/.//evil.example', '/a/..//evil.example', '/%2e//evil.example']) {
    const path = returnFrom(`/login?next=${encodeURIComponent(next)}`);
    assertEquals(path, '/', JSON.stringify(next));
    assertEquals(new URL(path, 'https://ein.test').host, 'ein.test');
  }
});

Deno.test('login return: a path is returned as the browser resolves it', () => {
  assertEquals(returnFrom(`/login?next=${encodeURIComponent('/albums/./Sommar')}`), '/albums/Sommar');
  assertEquals(returnFrom(`/login?next=${encodeURIComponent('/a\\b')}`), '/a/b');
  assertEquals(returnFrom(`/login?next=${encodeURIComponent('/\tlogin')}`), '/');
});
