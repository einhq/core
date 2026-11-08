# device

A device under `/dev` keeps nothing itself: its endpoints, the `log`, `track` and `control` nodes
under it, hold its values. What is written to a device is raw input for its driver, which the VFS
hands to core's device manager (`DeviceWriteHandle`, `DeviceSink.input`); a read ends at once.
