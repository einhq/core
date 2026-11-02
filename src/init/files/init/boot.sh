# The root onto PostgreSQL, its files under the deployment's file roots. Without a file root the
# root boot was handed stays: the test harness's, already equipped.
if [ -n "$EXTERNAL_FILE_ROOT_PATH" ]; then
  mount / pg "filesPath=$EXTERNAL_FILE_ROOT_PATH,volatilePath=$EXTERNAL_VOLATILE_FILE_ROOT_PATH,name=root,noaudit=$VAR_PATH"
fi
