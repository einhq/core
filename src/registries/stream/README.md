# stream

A stream is live bytes from one writer to any number of readers, kept in this process's memory and
nowhere else: a camera's video, as its driver writes it. Nothing refers to devices; whoever opens
the node to write is its writer, while nobody else is.

- A reader joins at the latest start point the writer marked (`writeStart`, a keyframe), or at now
  when it marked none. It is given the stream's header first, when the writer marked one
  (`writeHeader`, fragmented MP4's initialization segment), then what was written since that start
  point, and then what is written from then on. What was written since a start point is kept up to
  `STREAM_READER_BUFFER`; past it a reader joins at now until the next. The bytes are not parsed.
- Each reader holds what it has not read, up to `STREAM_READER_BUFFER` (8 MiB). One that falls
  further behind reads what it holds and then its end: the writer never waits.
- A read waits while nothing has come, also while there is no writer. The writer's close ends the
  stream for the readers there then; a reader who wants more opens it again.
- The writer's `wanted` says whether anyone reads, and stays true `STREAM_GRACE_MS` (10 s) after the
  last reader left, so a producer runs only while it is read (`onWanted`).

A stream whose node is an `image/*` (a camera's `main.jpg`) is a picture stream: each write is one
whole picture, and a reader is given one picture and then its end, `cat` a JPEG.

- The latest picture, when it is at most `STREAM_PICTURE_FRESH_MS` (2 s) old. Otherwise the reader
  waits for the next, and while anyone waits the writer is `wanted`, with no grace: a picture is
  made only when someone asks for one, and readers asking together share it.
- A reader given no picture within `STREAM_PICTURE_WAIT_MS` (20 s) is given the latest there is, or
  its end when there is none.

`stat` gives a size of 0, and who has the stream open. The VFS opens a stream node here for `r`, and
for `w` or `a` as its writer (`isStreamWriter`).
