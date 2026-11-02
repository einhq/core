# EiN core: what this image passes on

EiN's own code is under the MIT licence, in /app/LICENSE. The image also carries code made by
others, each under its own licence.

## The packages core is built from, and the fonts

Every npm, JSR and deno.land package core's deno.lock pins, and the fonts of the Web UI, are listed
with their licences and notices in /app/src/builtin/ui/ui/public/licences.txt, which EiN serves at
/public/licences.txt and About EiN links to as "third-party notices". All of them are under
permissive licences.

## Deno

/usr/local/bin/deno is Deno 2.9.6 as its makers publish it, from their image
denoland/deno:bin-2.9.6, under the MIT licence; the licence's text, with the copyright notice it
asks to be kept, is /usr/share/doc/deno/LICENSE.md. Its source is https://github.com/denoland/deno
at the tag v2.9.6.

## Debian

The image is built on Debian 13 (trixie) and carries Debian's packages unmodified, each under its
own licence, many of them the GPL or the LGPL; each package's is in
/usr/share/doc/<package>/copyright. `dpkg-query -W` in the image lists every package with its
version. Their source is Debian's, at https://sources.debian.org/ and, for the exact version, at
https://snapshot.debian.org/.
