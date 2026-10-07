import { folderEndpoints, documentEndpoints, uploadEndpoints, versionEndpoints } from './nodes.js';
import { memberEndpoints, groupEndpoints } from './people.js';
import { activityEndpoints, permissionEndpoints } from './permissions.js';
import { roomEndpoints } from './rooms.js';

/** Every core API group and method: `dr.api.rooms.create(…)`, `POST {basePath}/rooms/create`. */
export const coreEndpoints = {
  rooms: roomEndpoints,
  folders: folderEndpoints,
  documents: documentEndpoints,
  versions: versionEndpoints,
  uploads: uploadEndpoints,
  members: memberEndpoints,
  groups: groupEndpoints,
  permissions: permissionEndpoints,
  activity: activityEndpoints,
};

export type CoreEndpoints = typeof coreEndpoints;
export { discardUpload } from './nodes.js';
export { iamAttributes, transition } from './rooms.js';
export { detach } from './people.js';
export type { NodeView, RoomView } from './common.js';
