import { assertMutationAccess, canDownloadFile, hiddenFields, projectCapabilities, type AccessUser } from './access.ts';
import { applyMutation, type Action, type Actor } from './engine.ts';
import { resolveModules, type ERPRecord, type Store } from './schema.ts';

function trustedActor(user: AccessUser, actor?: Actor): Actor {
  return { ...(typeof actor === 'object' ? actor : {}), id: user.userId, name: user.displayName, email: user.email, role: user.role };
}

export type UploadedProjectMedia = { size: number; httpMetadata?: {contentType?: string}; customMetadata?: Record<string, string> };
/** Resolve attachment metadata from storage; client-supplied URLs, types and sizes carry no authority. */
export async function validateProjectMediaReferences(store: Store, user: AccessUser, projectId: string, media: unknown, lookup: (key: string) => Promise<UploadedProjectMedia | null>): Promise<ERPRecord[]> {
  if (!Array.isArray(media) || media.length > 10) throw new Error('A project post may include up to 10 uploaded media files.');
  const result: ERPRecord[] = [];
  const seen = new Set<string>();
  for (const candidate of media) {
    if (!candidate || typeof candidate !== 'object' || typeof candidate.key !== 'string' || !/^files\/[a-zA-Z0-9-]+\/[a-zA-Z0-9._-]+$/.test(candidate.key) || seen.has(candidate.key)) throw new Error('Choose unique media files uploaded to this workspace.');
    seen.add(candidate.key);
    const uploaded = await lookup(candidate.key);
    if (!uploaded || !canDownloadFile(store, user, candidate.key, uploaded.customMetadata)) throw new Error('FORBIDDEN: You cannot link a restricted file.');
    if (uploaded.customMetadata?.module !== 'projectPosts' || uploaded.customMetadata?.projectId !== projectId) throw new Error('Media must be uploaded for this project.');
    result.push({ id: candidate.key, key: candidate.key, url: '/api/files?key=' + encodeURIComponent(candidate.key), name: uploaded.customMetadata.name || 'Media', type: uploaded.httpMetadata?.contentType || 'application/octet-stream', size: uploaded.size });
  }
  return result;
}

/** The dedicated operational mutation never accepts financial or assignment fields. */
export function updateProjectProgress(store: Store, user: AccessUser, projectId: string, data: Partial<ERPRecord>, actor?: Actor): {store: Store; record: ERPRecord} {
  if (!projectCapabilities(store, user, projectId).updateProgress) throw new Error('FORBIDDEN: You cannot update progress in this project.');
  if (Object.keys(data).some(key => !['progress', 'stage'].includes(key))) throw new Error('Only project progress and stage may be changed here.');
  const changes: Partial<ERPRecord> = {};
  if (Object.prototype.hasOwnProperty.call(data, 'progress')) {
    if (typeof data.progress !== 'number' || !Number.isFinite(data.progress) || data.progress < 0 || data.progress > 100) throw new Error('Progress must be a number between 0 and 100.');
    changes.progress = data.progress;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'stage')) {
    const options = resolveModules(store).find(module => module.id === 'projects')!.fields.find(field => field.key === 'status')!.options || [];
    if (typeof data.stage !== 'string' || !options.includes(data.stage)) throw new Error('Choose a configured project stage.');
    changes.status = data.stage;
  }
  if (!Object.keys(changes).length) throw new Error('Provide project progress or a stage.');
  for (const key of hiddenFields(store, user, 'projects')) if (Object.prototype.hasOwnProperty.call(changes, key)) throw new Error('FORBIDDEN: You cannot change a restricted field.');
  const result = applyMutation(store, 'projects', 'update', changes, projectId, trustedActor(user, actor));
  result.record.lastProgressBy = user.userId;
  result.record.lastProgressAt = result.record.updatedAt;
  return result;
}

/** Create an update and its project progress atomically; moderation never replays or reverses history. */
export function mutateProjectPost(store: Store, user: AccessUser, action: Action, data: Partial<ERPRecord>, id?: string, actor?: Actor): {store: Store; record: ERPRecord} {
  const existing = id ? (store.projectPosts || []).find(row => row.id === id) : undefined;
  assertMutationAccess(store, user, 'projectPosts', action, data, existing);
  let next = store;
  const postData = { ...data };
  if (action === 'create' && (Object.prototype.hasOwnProperty.call(data, 'progress') || data.stage)) {
    const progressData: Partial<ERPRecord> = {};
    if (Object.prototype.hasOwnProperty.call(data, 'progress')) progressData.progress = data.progress;
    if (data.stage) progressData.stage = data.stage;
    const progressResult = updateProjectProgress(next, user, String(data.project), progressData, actor);
    next = progressResult.store;
    postData.progress = progressResult.record.progress;
  }
  return applyMutation(next, 'projectPosts', action, postData, id, trustedActor(user, actor));
}
