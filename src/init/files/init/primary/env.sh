# Path variables are exported by src/init/boot.ts from src/lib/paths.ts, which is
# the single source of truth for the layout — including PATH, which must already
# carry core's bin directory when the first command runs. What is left
# here is the per-instance identity that has no business being a TypeScript
# constant.
export COOKIE_NAME="ein"
