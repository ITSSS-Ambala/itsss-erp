"use client";

import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { ArrowDownWideNarrow, ArrowUpWideNarrow, Camera, Check, CheckCheck, Clock3, FileAudio, ImagePlus, LoaderCircle, MessageCircle, Paperclip, Pencil, Pin, Send, Trash2, TrendingUp, Video, X } from "lucide-react";
import CreatableSelect from "./creatable-select";
import "./project-timeline.css";

type Project = { id: string; name?: string; status?: string; progress?: number; [key: string]: any };
type Media = { name: string; key?: string; url?: string; size?: number; type?: string };
type TimelinePost = { id: string; project: string; kind?: string; body?: string; media?: Media[]; parent?: string; progress?: number; stage?: string; pinned?: boolean; authorId?: string; authorName?: string; authorRole?: string; postedAt?: string; createdAt?: string; updatedAt?: string; deletedAt?: string; archivedAt?: string; [key: string]: any };
type PendingMedia = { id: string; file: File; preview: string; uploaded?: Media; uploading?: boolean; error?: string };
type Mutation = (module: string, action: string, data: Record<string, any>, id?: string) => Promise<any | false>;
export type ProjectTimelineProps = {
  project: Project;
  posts: any[];
  user: any;
  capabilities: { post?: boolean; updateProgress?: boolean; managePosts?: boolean };
  canAttachMedia?: boolean;
  busy: boolean;
  error?: string;
  mutate: Mutation;
  onToast: (message: string) => void;
  stages: string[];
  onCreateStage?: (name: string, onCreated: (value: string) => void) => void;
};

const MAX_FILES = 10;
const MAX_BODY = 10_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const AUDIO_TYPES = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/ogg", "audio/mp4", "audio/x-m4a", "audio/aac"]);
const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/avif";
const VIDEO_ACCEPT = "video/mp4,video/webm,video/quicktime";
const AUDIO_ACCEPT = "audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/aac,.mp3,.wav,.ogg,.m4a,.aac";
const extension = (name: string) => name.toLowerCase().split(".").at(-1) || "";
const mediaKind = (media: { type?: string; name?: string }) => media.type?.startsWith("image/") || /^(jpe?g|png|webp|gif|avif)$/.test(extension(media.name || "")) ? "image" : media.type?.startsWith("video/") || /^(mp4|webm|mov)$/.test(extension(media.name || "")) ? "video" : "audio";
const percentage = (value: unknown) => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
const dateValue = (post: TimelinePost) => new Date(post.postedAt || post.createdAt || "").getTime() || 0;
function dateLabel(value?: string) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "Date unavailable";
}
function initials(name: string) { return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "T"; }
function fileSize(size?: number) { return size ? size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB` : ""; }
function mediaUrl(media: Media, inline = true) {
  const base = media.key ? `/api/files?key=${encodeURIComponent(media.key)}` : media.url?.startsWith("/api/files?") ? media.url.replace(/&inline=1\b/g, "") : "";
  return base ? `${base}${inline ? "&inline=1" : ""}` : "";
}
function validateFile(file: File): string | undefined {
  const kind = mediaKind(file);
  const known = IMAGE_TYPES.has(file.type) || VIDEO_TYPES.has(file.type) || AUDIO_TYPES.has(file.type) || !file.type && /^(jpe?g|png|webp|gif|avif|mp4|webm|mov|mp3|wav|ogg|m4a|aac)$/.test(extension(file.name));
  if (!known) return `${file.name}: choose a JPEG, PNG, WebP, GIF, AVIF, MP4, WebM, MOV, or supported audio file.`;
  const limit = (kind === "video" ? 100 : 20) * 1024 * 1024;
  if (!file.size || file.size > limit) return `${file.name}: ${kind === "video" ? "videos must be between 1 byte and 100 MB" : "images and audio must be between 1 byte and 20 MB"}.`;
}

function MediaGrid({ media }: { media: Media[] }) {
  if (!media.length) return null;
  return <div className="ptl-media-grid">{media.map((file, index) => {
    const url = mediaUrl(file), kind = mediaKind(file);
    return <figure key={file.key || `${file.name}-${index}`} className={`ptl-media ptl-media-${kind}`}>
      {url ? kind === "image" ? <a href={url} target="_blank" rel="noreferrer" aria-label={`Open photo ${file.name}`}><img src={url} alt={file.name} loading="lazy" /></a> : kind === "video" ? <video src={url} controls playsInline preload="metadata" aria-label={`Video: ${file.name}`} /> : <div className="ptl-audio"><FileAudio size={22} /><audio src={url} controls preload="metadata" aria-label={`Audio: ${file.name}`} /></div> : <div className="ptl-media-unavailable"><Paperclip size={22} /><span>Attachment unavailable</span></div>}
      <figcaption><span title={file.name}>{file.name}</span><small>{fileSize(file.size)}</small></figcaption>
    </figure>;
  })}</div>;
}

type ComposerProps = {
  project: Project; user: any; busy: boolean; disabled?: boolean; error?: string; stages: string[]; canUpdate: boolean; canAttachMedia: boolean;
  editing?: TimelinePost; reply?: TimelinePost; replyMissing?: boolean; textareaId?: string;
  onCancel?: () => void; clearReply?: () => void;
  onSubmit: (data: Record<string, any>) => Promise<boolean>;
  onCreateStage?: ProjectTimelineProps["onCreateStage"];
};
function TimelineComposer({ project, user, busy, disabled = false, error, stages, canUpdate, canAttachMedia, editing, reply, replyMissing, textareaId, onCancel, clearReply, onSubmit, onCreateStage }: ComposerProps) {
  const generatedId = useId();
  const textId = textareaId || `timeline-message-${generatedId}`;
  const [body, setBody] = useState(editing?.body || "");
  const [mode, setMode] = useState("Comment");
  const [includeProgress, setIncludeProgress] = useState(false);
  const [progress, setProgress] = useState(percentage(project.progress));
  const [stage, setStage] = useState(project.status || "");
  const [existingMedia, setExistingMedia] = useState<Media[]>(editing?.media || []);
  const [pending, setPending] = useState<PendingMedia[]>([]);
  const [localError, setLocalError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const urls = useRef(new Map<string, string>());
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const photosInput = useRef<HTMLInputElement>(null), videosInput = useRef<HTMLInputElement>(null), audioInput = useRef<HTMLInputElement>(null), cameraInput = useRef<HTMLInputElement>(null);
  const locked = busy || submitting || disabled;
  const update = !editing && !reply && !replyMissing && canUpdate && mode === "Update";
  const stageOptions = [...new Set([...stages, ...(project.status ? [project.status] : [])])];
  const attachmentCount = canAttachMedia ? existingMedia.length + pending.length : 0;
  const author = user?.displayName || user?.name || "You";

  useEffect(() => {
    mounted.current = true;
    const objectUrls = urls.current;
    return () => { mounted.current = false; controller.current?.abort(); objectUrls.forEach(url => URL.revokeObjectURL(url)); objectUrls.clear(); };
  }, []);
  useEffect(() => {
    if (!submitting) return;
    const protectPublishing = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
    };
    document.addEventListener("keydown", protectPublishing, true);
    return () => document.removeEventListener("keydown", protectPublishing, true);
  }, [submitting]);

  function addFiles(files: File[]) {
    if (locked || !canAttachMedia || !files.length) return;
    if (attachmentCount + files.length > MAX_FILES) { setLocalError(`Attach up to ${MAX_FILES} files per post. Remove a file before adding more.`); return; }
    const invalid = files.map(validateFile).find(Boolean);
    if (invalid) { setLocalError(invalid); return; }
    const additions = files.map(file => {
      const id = crypto.randomUUID(), preview = URL.createObjectURL(file);
      urls.current.set(id, preview);
      return { id, file, preview };
    });
    setPending(previous => [...previous, ...additions]);
    setLocalError("");
  }
  function chooseFiles(event: ChangeEvent<HTMLInputElement>) { addFiles(Array.from(event.currentTarget.files || [])); event.currentTarget.value = ""; }
  function removePending(id: string) {
    const url = urls.current.get(id);
    if (url) URL.revokeObjectURL(url);
    urls.current.delete(id);
    setPending(previous => previous.filter(file => file.id !== id));
    setLocalError("");
  }
  function resetDraft() {
    urls.current.forEach(url => URL.revokeObjectURL(url)); urls.current.clear();
    setPending([]); setExistingMedia([]); setBody(""); setMode("Comment"); setIncludeProgress(false); setProgress(percentage(project.progress)); setStage(project.status || ""); clearReply?.();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (locked || replyMissing) return;
    if (!body.trim() && !attachmentCount) { setLocalError("Write a comment or attach a photo, video, or audio file."); return; }
    if (body.length > MAX_BODY) { setLocalError("Keep your message under 10,000 characters."); return; }
    setLocalError(""); setSubmitting(true);
    controller.current = new AbortController();
    try {
      const attachments = canAttachMedia ? [...existingMedia] : [];
      for (const item of canAttachMedia ? pending : []) {
        if (item.uploaded) { attachments.push(item.uploaded); continue; }
        setPending(previous => previous.map(file => file.id === item.id ? { ...file, uploading: true, error: undefined } : file));
        try {
          const formData = new FormData(); formData.append("file", item.file); formData.append("module", "projectPosts"); formData.append("projectId", project.id);
          const response = await fetch("/api/files", { method: "POST", body: formData, signal: controller.current.signal });
          const uploaded = await response.json() as Media & { error?: string };
          if (!response.ok) throw new Error(uploaded.error || "Upload failed. Please retry.");
          if (!uploaded.key || !uploaded.name) throw new Error("The upload response is incomplete. Please retry.");
          if (!mounted.current) return;
          setPending(previous => previous.map(file => file.id === item.id ? { ...file, uploading: false, uploaded } : file));
          attachments.push(uploaded);
        } catch (uploadError: any) {
          if (mounted.current) setPending(previous => previous.map(file => file.id === item.id ? { ...file, uploading: false, error: uploadError.message } : file));
          throw new Error(`${item.file.name}: ${uploadError.message}`);
        }
      }
      if (!mounted.current) return;
      const data: Record<string, any> = { body: body.trim() };
      if (canAttachMedia) data.media = attachments;
      if (!editing) { data.project = project.id; data.kind = update ? "Update" : "Comment"; if (reply) data.parent = reply.id; if (update && includeProgress) { data.progress = progress; if (stage) data.stage = stage; } }
      if (await onSubmit(data)) { if (mounted.current) resetDraft(); }
      else if (mounted.current) setLocalError("Your post could not be saved. Your message and attachments are kept; please retry.");
    } catch (submitError: any) {
      if (mounted.current && submitError.name !== "AbortError") setLocalError(`${submitError.message} Your draft is kept. Retry or remove the failed file.`);
    } finally {
      if (mounted.current) { setSubmitting(false); requestAnimationFrame(() => document.getElementById(textId)?.focus({ preventScroll: true })); }
      controller.current = null;
    }
  }

  return <form className={`ptl-composer ${editing ? "ptl-composer-edit" : ""}`} onSubmit={submit} onKeyDown={event => { if (event.key === "Escape" && (editing || submitting)) { event.preventDefault(); event.stopPropagation(); if (!busy && !submitting) onCancel?.(); } }}>
    {!editing && <div className="ptl-composer-top"><span className="ptl-avatar ptl-avatar-you">{initials(author)}</span><div><strong>Keep everyone in the loop</strong><small>Share a work update, ask a question, or add photos.</small></div>{canUpdate && !reply && !replyMissing && <div className="ptl-mode-switch" aria-label="Post type"><button type="button" disabled={locked} aria-pressed={mode === "Comment"} className={mode === "Comment" ? "ptl-selected" : ""} onClick={() => { setMode("Comment"); setIncludeProgress(false); }}><MessageCircle size={12} />Comment</button><button type="button" disabled={locked} aria-pressed={mode === "Update"} className={mode === "Update" ? "ptl-selected" : ""} onClick={() => { setMode("Update"); setIncludeProgress(false); setProgress(percentage(project.progress)); setStage(project.status || ""); }}><TrendingUp size={12} />Update</button></div>}</div>}
    {(reply || replyMissing) && <div className="ptl-reply-banner"><MessageCircle size={13} /><span>{replyMissing ? "Original post is no longer available. Clear this reply to post a comment." : `Replying to ${reply?.authorName || "a team member"}`}</span><button type="button" disabled={locked} aria-label="Clear reply" onClick={clearReply}><X size={14} /></button></div>}
    {editing && <div className="ptl-edit-heading"><Pencil size={13} /><strong>Edit timeline entry</strong><small>Update the message and attachments.</small></div>}
    <label className="ptl-sr-only" htmlFor={textId}>{editing ? "Edit post message" : reply ? "Write a reply" : "Write a project comment or update"}</label>
    <textarea id={textId} autoFocus={Boolean(editing)} value={body} maxLength={MAX_BODY} disabled={locked} onChange={event => setBody(event.target.value)} placeholder={editing ? "Add details about this work…" : reply ? "Write a reply…" : update ? "What has been completed? Add details about the work…" : "Write a comment or share what’s happening on site…"} rows={editing ? 3 : 4} />
    {update && <label className="ptl-progress-opt-in"><input type="checkbox" checked={includeProgress} disabled={locked} onChange={event => setIncludeProgress(event.target.checked)} /><span>Update project progress with this post</span></label>}
    {update && includeProgress && <div className="ptl-progress-editor"><label htmlFor={`progress-${generatedId}`}><span>Project progress</span><strong>{progress}%</strong></label><input id={`progress-${generatedId}`} type="range" min="0" max="100" step="1" value={progress} disabled={locked} onChange={event => setProgress(Number(event.target.value))} /><div className="ptl-stage-field"><label htmlFor={`stage-${generatedId}`}>Project stage</label><CreatableSelect id={`stage-${generatedId}`} label="Project stage" value={stage} options={stageOptions.map(option => ({ value: option, label: option }))} disabled={locked} onChange={value => setStage(String(value))} onCreate={onCreateStage ? name => onCreateStage(name, value => setStage(value)) : undefined} /></div><p><CheckCheck size={12} />Publishing this update also saves the project’s progress.</p></div>}
    {canAttachMedia && existingMedia.length > 0 && <div className="ptl-existing-media">{existingMedia.map((file, index) => <div key={file.key || `${file.name}-${index}`}><Paperclip size={13} /><span title={file.name}>{file.name}</span><button type="button" disabled={locked} aria-label={`Remove attachment ${file.name}`} onClick={() => setExistingMedia(previous => previous.filter((_, i) => i !== index))}><X size={13} /></button></div>)}</div>}
    {canAttachMedia && pending.length > 0 && <div className="ptl-pending-media">{pending.map(item => <div className={`ptl-pending-file ${item.error ? "ptl-pending-error" : ""}`} key={item.id}>{mediaKind(item.file) === "image" ? <img src={item.preview} alt={`Preview of ${item.file.name}`} /> : <span className="ptl-file-type">{mediaKind(item.file) === "video" ? <Video size={20} /> : <FileAudio size={20} />}</span>}<span><strong title={item.file.name}>{item.file.name}</strong><small>{item.uploading ? "Uploading…" : item.error ? "Upload failed · retry or remove" : item.uploaded ? "Ready to publish" : fileSize(item.file.size)}</small></span>{item.uploading ? <LoaderCircle size={15} className="ptl-spin" /> : item.uploaded ? <Check size={14} className="ptl-ready" /> : null}<button type="button" disabled={locked} aria-label={`Remove ${item.file.name}`} onClick={() => removePending(item.id)}><X size={13} /></button></div>)}</div>}
    {(localError || error) && <div className="ptl-error" role="alert">{localError || error}</div>}
    <div className="ptl-composer-bottom" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); addFiles(Array.from(event.dataTransfer.files)); }}>{canAttachMedia && <div className="ptl-attach-actions"><button type="button" disabled={locked || attachmentCount >= MAX_FILES} onClick={() => photosInput.current?.click()} aria-label="Attach photos" title="Attach photos"><ImagePlus size={16} /><span>Photo</span></button><button type="button" disabled={locked || attachmentCount >= MAX_FILES} onClick={() => videosInput.current?.click()} aria-label="Attach videos" title="Attach videos"><Video size={16} /><span>Video</span></button><button type="button" disabled={locked || attachmentCount >= MAX_FILES} onClick={() => audioInput.current?.click()} aria-label="Attach audio" title="Attach audio"><FileAudio size={16} /><span>Audio</span></button><button type="button" disabled={locked || attachmentCount >= MAX_FILES} onClick={() => cameraInput.current?.click()} aria-label="Take a photo" title="Take a photo"><Camera size={16} /><span>Camera</span></button></div>}<div className="ptl-publish-actions">{editing && <button type="button" className="ptl-cancel" disabled={busy || submitting} onClick={onCancel}>Cancel</button>}<button type="submit" className="ptl-publish" disabled={locked || replyMissing || !body.trim() && !attachmentCount}>{submitting ? <LoaderCircle size={14} className="ptl-spin" /> : <Send size={14} />}{submitting ? "Publishing…" : editing ? "Save changes" : reply ? "Send reply" : update ? "Publish update" : "Post comment"}</button></div></div>
    <div className="ptl-attachment-note"><span>{canAttachMedia ? `${attachmentCount ? `${attachmentCount}/${MAX_FILES} files attached` : "Up to 10 attachments"} · photos/audio 20 MB · videos 100 MB` : "Attachments are unavailable for your role."}</span>{body.length > 9000 && <span>{body.length.toLocaleString()}/{MAX_BODY.toLocaleString()}</span>}</div>
    {canAttachMedia && <><input className="ptl-hidden-input" ref={photosInput} type="file" accept={IMAGE_ACCEPT} multiple onChange={chooseFiles} tabIndex={-1} aria-label="Choose project photos" disabled={locked} /><input className="ptl-hidden-input" ref={videosInput} type="file" accept={VIDEO_ACCEPT} multiple onChange={chooseFiles} tabIndex={-1} aria-label="Choose project videos" disabled={locked} /><input className="ptl-hidden-input" ref={audioInput} type="file" accept={AUDIO_ACCEPT} multiple onChange={chooseFiles} tabIndex={-1} aria-label="Choose project audio" disabled={locked} /><input className="ptl-hidden-input" ref={cameraInput} type="file" accept={IMAGE_ACCEPT} capture="environment" onChange={chooseFiles} tabIndex={-1} aria-label="Take a project photo" disabled={locked} /></>}
  </form>;
}

type PostCardProps = { post: TimelinePost; project: Project; user: any; capabilities: ProjectTimelineProps["capabilities"]; busy: boolean; canAttachMedia: boolean; stages: string[]; mutate: Mutation; onToast: (message: string) => void; onReply: (post: TimelinePost) => void; reply?: boolean; depth?: number; parentContext?: TimelinePost; children?: React.ReactNode };
function PostCard({ post, project, user, capabilities, canAttachMedia, busy, stages, mutate, onToast, onReply, reply = false, depth = 0, parentContext, children }: PostCardProps) {
  const [editing, setEditing] = useState(false), [confirmDelete, setConfirmDelete] = useState(false), [localError, setLocalError] = useState("");
  const deleteRef = useRef<HTMLButtonElement>(null), confirmRef = useRef<HTMLButtonElement>(null), editRef = useRef<HTMLButtonElement>(null);
  const owns = Boolean(post.authorId && [user?.userId, user?.id].includes(post.authorId));
  const canManage = Boolean(capabilities.managePosts || owns && capabilities.post);
  const author = post.authorName || "Team member";
  const isUpdate = post.kind === "Update";
  const postedAt = post.postedAt || post.createdAt;
  useEffect(() => { if (confirmDelete) confirmRef.current?.focus(); }, [confirmDelete]);
  function closeEdit() { setEditing(false); requestAnimationFrame(() => editRef.current?.focus({ preventScroll: true })); }
  async function updatePost(data: Record<string, any>) {
    if (!canManage) { setLocalError("Your permission to edit this entry has changed."); return false; }
    setLocalError("");
    try { const result = await mutate("projectPosts", "update", data, post.id); if (!result) { setLocalError("The post could not be updated. Please retry."); return false; } closeEdit(); onToast("Timeline entry updated"); return true; } catch (error: any) { setLocalError(error.message); return false; }
  }
  async function deletePost() {
    if (!canManage) { setLocalError("Your permission to delete this entry has changed."); return; }
    setLocalError("");
    try { if (await mutate("projectPosts", "delete", {}, post.id)) { setConfirmDelete(false); onToast("Timeline entry deleted"); } else setLocalError("The post could not be deleted. Please retry."); } catch (error: any) { setLocalError(error.message); }
  }
  return <article className={`ptl-post ${reply ? "ptl-post-reply" : ""} ${depth >= 2 ? "ptl-reply-depth-two" : ""} ${post.pinned ? "ptl-post-pinned" : ""}`} onKeyDown={event => { if (event.key === "Escape" && (confirmDelete || editing)) { event.preventDefault(); event.stopPropagation(); if (!busy) { if (editing) closeEdit(); if (confirmDelete) { setConfirmDelete(false); deleteRef.current?.focus(); } } } }}>
    {!reply && <span className={`ptl-timeline-dot ${isUpdate ? "ptl-dot-update" : ""}`}>{isUpdate ? <TrendingUp size={13} /> : <MessageCircle size={12} />}</span>}
    <header className="ptl-post-header"><span className={`ptl-avatar ${isUpdate ? "ptl-avatar-update" : ""}`}>{initials(author)}</span><div className="ptl-post-author"><strong>{author}{post.authorRole && <span>{post.authorRole}</span>}</strong><div><time dateTime={postedAt} title={dateLabel(postedAt)}>{dateLabel(postedAt)}</time>{post.updatedAt && post.updatedAt !== postedAt && <small>Edited</small>}</div></div><div className="ptl-post-badges">{post.pinned && <span className="ptl-pinned-label"><Pin size={10} />Pinned</span>}{isUpdate && <span className="ptl-update-label">Progress update</span>}</div>{canManage && !editing && <div className="ptl-post-actions">{capabilities.managePosts && <button type="button" disabled={busy} title={post.pinned ? "Unpin entry" : "Pin entry"} aria-label={post.pinned ? "Unpin timeline entry" : "Pin timeline entry"} className={post.pinned ? "ptl-is-pinned" : ""} onClick={() => updatePost({ pinned: !post.pinned })}><Pin size={13} /></button>}<button ref={editRef} type="button" disabled={busy} aria-label="Edit timeline entry" title="Edit entry" onClick={() => { setLocalError(""); setEditing(true); }}><Pencil size={13} /></button><button ref={deleteRef} type="button" disabled={busy} aria-label="Delete timeline entry" title="Delete entry" onClick={() => setConfirmDelete(true)}><Trash2 size={13} /></button></div>}</header>
    {parentContext && <div className="ptl-parent-context"><MessageCircle size={11} /><span>Reply to {parentContext.authorName || "a team member"}</span><small>{(parentContext.body || (parentContext.kind === "Update" ? "Progress update" : "Comment")).slice(0, 120)}</small></div>}
    {editing ? <TimelineComposer project={project} user={user} busy={busy} disabled={!canManage} stages={stages} canUpdate={false} canAttachMedia={canAttachMedia} editing={post} error={localError || (!canManage ? "Your permission to edit this entry has changed. Your draft is kept." : "")} onCancel={closeEdit} onSubmit={updatePost} /> : <>{isUpdate && (post.progress !== undefined || post.stage) && <div className="ptl-update-details">{post.progress !== undefined && <span><TrendingUp size={13} /><strong>{percentage(post.progress)}%</strong> complete</span>}{post.stage && <span className="ptl-stage-tag">{post.stage}</span>}</div>}{post.body && <p className="ptl-post-body">{post.body}</p>}<MediaGrid media={Array.isArray(post.media) ? post.media : []} />{capabilities.post && <footer className="ptl-post-footer"><button type="button" disabled={busy} onClick={() => onReply(post)}><MessageCircle size={13} />Reply</button></footer>}</>}
    {localError && !editing && <div className="ptl-error" role="alert">{localError}</div>}
    {confirmDelete && <div className="ptl-delete-confirm" role="alertdialog" aria-label="Delete timeline entry"><div><strong>Delete this entry?</strong><p>The entry will be removed from this project’s timeline.</p></div><button type="button" disabled={busy} onClick={() => { setConfirmDelete(false); deleteRef.current?.focus(); }}>Cancel</button><button ref={confirmRef} className="ptl-delete-button" type="button" disabled={busy || !canManage} onClick={deletePost}>{busy ? "Deleting…" : "Delete entry"}</button></div>}
    {children}
  </article>;
}

export default function ProjectTimeline({ project, posts, user, capabilities, canAttachMedia = true, busy, error, mutate, onToast, stages, onCreateStage }: ProjectTimelineProps) {
  const [order, setOrder] = useState("newest"), [filter, setFilter] = useState("all"), [replyTo, setReplyTo] = useState<string | null>(null);
  const composerId = `project-composer-${useId()}`;
  const progress = percentage(project.progress);
  const allPosts = useMemo<TimelinePost[]>(() => posts.filter(post => post.project === project.id && !post.deletedAt && !post.archivedAt), [posts, project.id]);
  const allPostsById = useMemo(() => new Map(allPosts.map(post => [post.id, post])), [allPosts]);
  const visiblePosts = useMemo(() => allPosts.filter(post => filter === "all" || (filter === "updates" ? post.kind === "Update" : post.kind !== "Update")), [allPosts, filter]);
  const visibleIds = useMemo(() => new Set(visiblePosts.map(post => post.id)), [visiblePosts]);
  const rootPosts = useMemo(() => {
    return visiblePosts.filter(post => !post.parent || !visibleIds.has(post.parent)).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (order === "newest" ? dateValue(b) - dateValue(a) : dateValue(a) - dateValue(b)));
  }, [visiblePosts, visibleIds, order]);
  const repliesByParent = useMemo(() => {
    const result = new Map<string, TimelinePost[]>();
    visiblePosts.filter(post => post.parent).forEach(post => result.set(post.parent!, [...(result.get(post.parent!) || []), post]));
    result.forEach(replies => replies.sort((a, b) => dateValue(a) - dateValue(b)));
    return result;
  }, [visiblePosts]);
  const replyPost = allPosts.find(post => post.id === replyTo);
  const latest = [...allPosts].sort((a, b) => dateValue(b) - dateValue(a))[0];
  const stageList = [...new Set(stages)].filter(stage => !["on hold", "cancelled", "canceled"].includes(stage.trim().toLowerCase())), stageIndex = stageList.indexOf(project.status || "");
  const counts = { updates: allPosts.filter(post => post.kind === "Update").length, comments: allPosts.filter(post => post.kind !== "Update").length, media: allPosts.reduce((count, post) => count + (Array.isArray(post.media) ? post.media.length : 0), 0) };
  function reply(post: TimelinePost) { setReplyTo(post.id); requestAnimationFrame(() => { const textarea = document.getElementById(composerId); textarea?.focus({ preventScroll: true }); textarea?.scrollIntoView({ block: "center" }); }); }
  const postProps = { project, user, capabilities, canAttachMedia, busy, stages, mutate, onToast, onReply: reply };
  function renderPost(post: TimelinePost): React.ReactNode {
    const visited = new Set([post.id]);
    const replies: Array<{ post: TimelinePost; depth: number }> = [];
    const stack = [...(repliesByParent.get(post.id) || [])].reverse().map(child => ({ post: child, depth: 1 }));
    while (stack.length) {
      const current = stack.pop()!;
      if (visited.has(current.post.id)) continue;
      visited.add(current.post.id); replies.push(current);
      for (const child of [...(repliesByParent.get(current.post.id) || [])].reverse()) stack.push({ post: child, depth: current.depth + 1 });
    }
    const parentContext = post.parent && !visibleIds.has(post.parent) ? allPostsById.get(post.parent) : undefined;
    return <PostCard key={post.id} {...postProps} post={post} parentContext={parentContext}>{replies.length > 0 && <div className="ptl-replies"><span className="ptl-reply-count"><MessageCircle size={11} />{replies.length} {replies.length === 1 ? "reply" : "replies"}</span>{replies.map(item => <PostCard key={item.post.id} {...postProps} post={item.post} reply depth={Math.min(item.depth, 2)} parentContext={item.depth > 1 && item.post.parent ? allPostsById.get(item.post.parent) : undefined} />)}</div>}</PostCard>;
  }

  return <section className="ptl-root" aria-label={`${project.name || "Project"} progress timeline`} onKeyDown={event => { if (event.key === "Escape" && replyTo) { event.preventDefault(); event.stopPropagation(); if (!busy) setReplyTo(null); } }}>
    <div className="ptl-progress-summary"><div className="ptl-progress-summary-top"><div><span className="ptl-eyebrow"><TrendingUp size={12} />PROJECT PROGRESS</span><h3>Every step, in one place.</h3><p>{project.name || "Project timeline"}</p></div><div className="ptl-progress-value"><strong>{progress}<span>%</span></strong><small>{project.status || "In progress"}</small></div></div><div className="ptl-progress-track" role="progressbar" aria-label="Project completion" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>{stageList.length > 0 && <ol className="ptl-stages" aria-label="Project stages">{stageList.map((stage, index) => <li key={stage} className={index === stageIndex ? "ptl-stage-current" : stageIndex >= 0 && index < stageIndex ? "ptl-stage-complete" : ""} aria-current={index === stageIndex ? "step" : undefined}><span>{stageIndex >= 0 && index < stageIndex ? <Check size={9} /> : index + 1}</span>{stage}</li>)}</ol>}<div className="ptl-summary-stats"><span><TrendingUp size={13} /><strong>{counts.updates}</strong> updates</span><span><MessageCircle size={13} /><strong>{counts.comments}</strong> comments</span><span><Paperclip size={13} /><strong>{counts.media}</strong> post files</span>{latest && <small><Clock3 size={11} />Last activity {dateLabel(latest.postedAt || latest.createdAt)}</small>}</div></div>
    {capabilities.post ? <TimelineComposer key={project.id} project={project} user={user} busy={busy} error={error} stages={stages} onCreateStage={onCreateStage} canUpdate={Boolean(capabilities.updateProgress)} canAttachMedia={canAttachMedia} reply={replyPost} replyMissing={Boolean(replyTo && !replyPost)} textareaId={composerId} clearReply={() => setReplyTo(null)} onSubmit={async data => { try { const result = await mutate("projectPosts", "create", data); if (result) { onToast(data.kind === "Update" ? "Progress update published" : data.parent ? "Reply posted" : "Comment posted"); return true; } return false; } catch { return false; } }} /> : <div className="ptl-readonly-note"><MessageCircle size={16} /><span>Follow your project’s progress and see updates from your team.</span></div>}
    <div className="ptl-feed-heading"><div><h3>Project activity</h3><span>{allPosts.length} {allPosts.length === 1 ? "entry" : "entries"}</span></div><div className="ptl-feed-controls"><div className="ptl-feed-filters" aria-label="Activity filter">{[["all", "All activity"], ["updates", "Updates"], ["comments", "Comments"]].map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} className={filter === value ? "ptl-selected" : ""} onClick={() => setFilter(value)}>{label}</button>)}</div><button type="button" className="ptl-sort" onClick={() => setOrder(value => value === "newest" ? "oldest" : "newest")} aria-label={`Sort ${order === "newest" ? "oldest" : "newest"} first`}>{order === "newest" ? <ArrowDownWideNarrow size={13} /> : <ArrowUpWideNarrow size={13} />}<span>{order === "newest" ? "Newest first" : "Oldest first"}</span></button></div></div>
    {rootPosts.length ? <div className="ptl-feed">{rootPosts.map(post => renderPost(post))}</div> : <div className="ptl-empty"><span><MessageCircle size={24} strokeWidth={1.5} /><span className="ptl-empty-plus">+</span></span><h4>{allPosts.length ? "No entries in this view" : "The next update starts here."}</h4><p>{allPosts.length ? "Choose All activity to see the full project timeline." : capabilities.post ? "Share your first update, add site photos, or start a conversation with the team." : "Work updates, photos, and conversations will appear here as your team posts them."}</p>{capabilities.post && !allPosts.length && <button type="button" onClick={() => document.getElementById(composerId)?.focus()}>Write the first comment<Send size={12} /></button>}</div>}
  </section>;
}
