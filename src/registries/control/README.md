# control

A control is a device's endpoint that is written to change the device: a switch, a setpoint. Its
states, as the device reported them, are kept as a log's entries are, in the log registry under the
control's id, so it is read as a log (`cat`, `tail -f`, `log-read`). A write is not stored: the VFS
hands it to the device's driver (`DeviceSink.command`). Only the driver appends, opened `a`.
