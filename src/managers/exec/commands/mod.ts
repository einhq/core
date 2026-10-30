/** Every command core registers. */

import type { CmdFunction } from '../types.ts';

import { groupAddMember } from './auth/group-add-member.ts';
import { groupCreate } from './auth/group-create.ts';
import { groupDelete } from './auth/group-delete.ts';
import { groupExists } from './auth/group-exists.ts';
import { groupInfo } from './auth/group-info.ts';
import { groupIsMember } from './auth/group-is-member.ts';
import { groupList } from './auth/group-list.ts';
import { groupMembers } from './auth/group-members.ts';
import { groupRemoveMember } from './auth/group-remove-member.ts';
import { groupResolve } from './auth/group-resolve.ts';
import { groupUpdate } from './auth/group-update.ts';
import { group } from './auth/group.ts';
import { userCreate } from './auth/user-create.ts';
import { userDelete } from './auth/user-delete.ts';
import { userDisable } from './auth/user-disable.ts';
import { userElevate } from './auth/user-elevate.ts';
import { userEnable } from './auth/user-enable.ts';
import { userExists } from './auth/user-exists.ts';
import { userGroups } from './auth/user-groups.ts';
import { userId } from './auth/user-id.ts';
import { userInfo } from './auth/user-info.ts';
import { userList } from './auth/user-list.ts';
import { userPasswd } from './auth/user-passwd.ts';
import { userResolve } from './auth/user-resolve.ts';
import { userSetPrimaryGroup } from './auth/user-set-primary-group.ts';
import { userUpdate } from './auth/user-update.ts';
import { userWhoami } from './auth/user-whoami.ts';
import { user } from './auth/user.ts';
import { config } from './config/config.ts';
import { configGet } from './config/config-get.ts';
import { configList } from './config/config-list.ts';
import { configPublish } from './config/config-publish.ts';
import { configSet } from './config/config-set.ts';
import { configUnset } from './config/config-unset.ts';
import { docs, docsCommands, docsEnv, docsFind, docsNodeTypes } from './docs/mod.ts';
import { findSimilar } from './embedding/find-similar.ts';
import { findContaining } from './position/find-containing.ts';
import { findNearby } from './position/find-nearby.ts';
import { positionGet } from './position/position-get.ts';
import { positionSet } from './position/position-set.ts';
import { httpServer } from './http-server.ts';
import { login } from './login.ts';
import { logout } from './logout.ts';
import { acl } from './node/acl.ts';
import { share } from './node/share/share.ts';
import { shareInfo } from './node/share/share-info.ts';
import { shareLink } from './node/share/share-link.ts';
import { shareSet } from './node/share/share-set.ts';
import { attrs } from './node/attrs.ts';
import { cat } from './node/cat.ts';
import { chmod } from './node/chmod.ts';
import { chown } from './node/chown.ts';
import { cp } from './node/cp.ts';
import { du } from './node/du.ts';
import { edit } from './node/edit/mod.ts';
import { find } from './node/find.ts';
import { info } from './node/info.ts';
import { ln } from './node/ln.ts';
import { ls } from './node/ls.ts';
import { members } from './node/members.ts';
import { mv } from './node/mv.ts';
import { props } from './node/props.ts';
import { rm } from './node/rm.ts';
import { rmdir } from './node/rmdir.ts';
import { comment } from './node/comment.ts';
import { label, labels } from './node/label.ts';
import { logAppend } from './node/log-append.ts';
import { relate, unrelate } from './node/relate.ts';
import { relationsGuard } from './node/relations-guard.ts';
import { star } from './node/star.ts';
import { trash } from './node/trash.ts';
import { unzip } from './node/unzip.ts';
import { stat } from './node/stat.ts';
import { basename } from './utils/basename.ts';
import { clear } from './utils/clear.ts';
import { dmesg } from './utils/dmesg.ts';
import { cut } from './utils/cut.ts';
import { date } from './utils/date.ts';
import { dirname } from './utils/dirname.ts';
import { env } from './utils/env.ts';
import { grep } from './utils/grep.ts';
import { head } from './utils/head.ts';
import { jq } from './utils/jq.ts';
import { mime } from './utils/mime.ts';
import { rev } from './utils/rev.ts';
import { sed } from './utils/sed.ts';
import { awk } from './utils/awk.ts';
import { fold } from './utils/fold.ts';
import { seq } from './utils/seq.ts';
import { sleep } from './utils/sleep.ts';
import { sort } from './utils/sort.ts';
import { tail } from './utils/tail.ts';
import { tr } from './utils/tr.ts';
import { truncate } from './utils/truncate.ts';
import { uniq } from './utils/uniq.ts';
import { uuid } from './utils/uuid.ts';
import { xargs } from './utils/xargs.ts';
import { wc } from './utils/wc.ts';
import { mount } from './vfs/mount.ts';
import { resolveId } from './vfs/resolve-id.ts';
import { reachCheck } from './vfs/reach-check.ts';
import { audit } from './vfs/audit.ts';
import { unmount } from './vfs/unmount.ts';
import { mknode } from './node/mknode.ts';
import { completeArg } from './completion/completion-arg.ts';
import { completeCommands } from './completion/completion-commands.ts';
import { completeEntity } from './completion/completion-entity.ts';
import { completeGroup } from './completion/completion-group.ts';
import { completePath } from './completion/completion-path.ts';
import { completeSubcommand } from './completion/completion-subcommand.ts';
import { completeUser } from './completion/completion-user.ts';
import { completion } from './completion/completion.ts';
import { modGroups } from './mod/mod-groups.ts';
import { modInfo } from './mod/mod-info.ts';
import { modInstall } from './mod/mod-install.ts';
import { modList } from './mod/mod-list.ts';
import { modRemove } from './mod/mod-remove.ts';
import { modSearch } from './mod/mod-search.ts';
import { modCache } from './mod/mod-cache.ts';
import { modSetup } from './mod/mod-setup.ts';
import { mod } from './mod/mod.ts';
import { fileStat } from './node/file-stat.ts';
import { fileSync } from './node/file-sync.ts';
import { serviceAdd } from './service/service-add.ts';
import { serviceDisable } from './service/service-disable.ts';
import { serviceEnable } from './service/service-enable.ts';
import { serviceList } from './service/service-list.ts';
import { serviceRemove } from './service/service-remove.ts';
import { serviceRestart } from './service/service-restart.ts';
import { serviceStartAll } from './service/service-start-all.ts';
import { serviceStart } from './service/service-start.ts';
import { serviceStatus } from './service/service-status.ts';
import { serviceStopAll } from './service/service-stop-all.ts';
import { serviceStop } from './service/service-stop.ts';
import { service } from './service/service.ts';
import { pipelineCancel } from './pipeline/pipeline-cancel.ts';
import { pipelineDefine } from './pipeline/pipeline-define.ts';
import { pipelineUndefine } from './pipeline/pipeline-undefine.ts';
import { pipelineEngine } from './pipeline/pipeline-engine.ts';
import { pipelineWorker } from './pipeline/pipeline-worker.ts';
import { pipelineInstances } from './pipeline/pipeline-instances.ts';
import { pipelineList } from './pipeline/pipeline-list.ts';
import { pipelineOverview } from './pipeline/pipeline-overview.ts';
import { pipelinePrune } from './pipeline/pipeline-prune.ts';
import { pipelineRemove } from './pipeline/pipeline-remove.ts';
import { pipelineHeal } from './pipeline/pipeline-heal.ts';
import { pipelineRepair } from './pipeline/pipeline-repair.ts';
import { pipelineRerun } from './pipeline/pipeline-rerun.ts';
import { pipelineRestart } from './pipeline/pipeline-restart.ts';
import { pipelineStart } from './pipeline/pipeline-start.ts';
import { pipelineStatus } from './pipeline/pipeline-status.ts';
import { pipelineStepRestart } from './pipeline/pipeline-step-restart.ts';
import { metricsSampler } from './system/metrics-sampler.ts';
import { sessionReap } from './system/session-reap.ts';
import { statsOverview } from './system/stats-overview.ts';
import { search } from './search/search.ts';
import { facets } from './search/facets.ts';
import { parseSearch } from './search/parse-search.ts';
import { events } from './feeds/events.ts';
import { news } from './feeds/news.ts';
import { onthisday } from './feeds/onthisday.ts';
import { df } from './system/df.ts';
import { hostMetrics } from './system/host-metrics.ts';
import { gauges, health } from './system/health.ts';
import { systemInfo } from './system/system-info.ts';
import { ps } from './system/ps.ts';
import { top } from './system/top/mod.ts';
import { who } from './system/who.ts';
import { pipeline } from './pipeline/pipeline.ts';
import { poolAdd } from './pool/pool-add.ts';
import { poolCancel } from './pool/pool-cancel.ts';
import { poolClaim } from './pool/pool-claim.ts';
import { poolList } from './pool/pool-list.ts';
import { poolPurge } from './pool/pool-purge.ts';
import { poolRetry } from './pool/pool-retry.ts';
import { poolStat } from './pool/pool-stat.ts';
import { poolWake } from './pool/pool-wake.ts';
import { pool } from './pool/pool.ts';
import { queueDead } from './queue/queue-dead.ts';
import { queuePeek } from './queue/queue-peek.ts';
import { sshServer } from './ssh-server.ts';
import { scp } from './remote/scp.ts';
import { sshCopyId } from './remote/ssh-copy-id.ts';
import { sshKeygen } from './remote/ssh-keygen.ts';
import { ssh } from './remote/ssh.ts';
import { abspath } from './utils/abspath.ts';
import { detach } from './job/detach.ts';
import { nohup } from './job/nohup.ts';
import { uiBuild } from '../../../builtin/ui/commands/ui-build.ts';
import { uiIcons } from '../../../builtin/ui/commands/ui-icons.ts';
import { uiNav } from '../../../builtin/ui/commands/ui-nav.ts';

export const COMMAND_NAMES: CmdFunction[] = [
  env,

  // User management
  user,
  userCreate,
  userDelete,
  userDisable,
  userElevate,
  userEnable,
  userExists,
  userGroups,
  userId,
  userInfo,
  userList,
  userPasswd,
  userResolve,
  userSetPrimaryGroup,
  userUpdate,
  userWhoami,

  // Group management
  group,
  groupAddMember,
  groupCreate,
  groupDelete,
  groupExists,
  groupInfo,
  groupIsMember,
  groupList,
  groupMembers,
  groupRemoveMember,
  groupResolve,
  groupUpdate,

  // Configuration
  config,
  configGet,
  configList,
  configPublish,
  configSet,
  configUnset,

  // Documentation
  docs,
  docsCommands,
  docsEnv,
  docsFind,
  docsNodeTypes,

  // Auth
  login,
  logout,

  // Filesystem
  abspath,
  attrs,
  awk,
  basename,
  cat,
  clear,
  cp,
  cut,
  date,
  dmesg,
  dirname,
  du,
  edit,
  fileStat,
  fileSync,
  grep,
  head,
  info,
  jq,
  ln,
  ls,
  members,
  mv,
  props,
  rev,
  rm,
  rmdir,
  sed,
  fold,
  seq,
  sleep,
  sort,
  tail,
  tr,
  truncate,
  uniq,
  xargs,
  unzip,
  wc,
  mime,
  find,
  findSimilar,
  findNearby,
  findContaining,
  positionGet,
  positionSet,
  resolveId,
  reachCheck,
  audit,
  mount,
  unmount,
  chmod,
  chown,
  acl,
  share,
  shareInfo,
  shareLink,
  shareSet,
  stat,
  mknode,
  logAppend,
  relate,
  unrelate,
  relationsGuard,
  label,
  labels,
  star,
  trash,
  comment,

  // Servers
  httpServer,
  sshServer,

  // Other machines
  ssh,
  scp,
  sshKeygen,
  sshCopyId,

  // Other
  uuid,

  // Module management
  mod,
  modGroups,
  modInfo,
  modCache,
  modInstall,
  modSetup,
  modList,
  modRemove,
  modSearch,

  // Service management
  service,
  serviceAdd,
  serviceDisable,
  serviceEnable,
  serviceList,
  serviceRemove,
  serviceRestart,
  serviceStartAll,
  serviceStart,
  serviceStatus,
  serviceStopAll,
  serviceStop,

  // Pipeline management
  pipeline,
  pipelineCancel,
  pipelineDefine,
  pipelineUndefine,
  pipelineEngine,
  pipelineWorker,
  pipelineInstances,
  pipelineList,
  pipelineOverview,
  pipelinePrune,
  pipelineRemove,
  pipelineHeal,
  pipelineRepair,
  pipelineRerun,
  pipelineRestart,
  pipelineStart,
  pipelineStatus,
  pipelineStepRestart,

  // System dashboard and statistics
  metricsSampler,
  sessionReap,
  statsOverview,
  df,
  hostMetrics,
  health,
  gauges,
  systemInfo,
  ps,
  top,
  who,

  // Search: the facets core reads itself, and the text the modules' providers match
  search,
  facets,
  parseSearch,

  // The home page's feeds, each gathered from the modules' providers of its name
  news,
  events,
  onthisday,

  // Work pools
  pool,
  poolAdd,
  poolCancel,
  poolClaim,
  poolList,
  poolPurge,
  poolRetry,
  poolStat,
  poolWake,

  // Queues
  queueDead,
  queuePeek,

  // Job control; jobs, wait, kill, disown, fg and bg are the shell's builtins
  detach,
  nohup,

  // The web UI: its navigation, its icons and the modules' pages
  uiBuild,
  uiIcons,
  uiNav,

  // Auto-complete
  completion,
  completeArg,
  completeCommands,
  completeEntity,
  completeGroup,
  completePath,
  completeSubcommand,
  completeUser,
];
