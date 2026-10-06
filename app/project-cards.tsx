'use client';
import {ArrowUpRight, CalendarClock, CheckCircle2, MapPin, MessageSquare, Milestone} from 'lucide-react';
import './project-cards.css';

type RecordRow={id:string;[key:string]:any};
export default function ProjectCards({projects,store,stages=[],open}: {
  projects:RecordRow[];store:Record<string,RecordRow[]>;stages?:string[];open:(project:RecordRow)=>void;
}) {
  const phases=stages.filter(stage=>!['On Hold','Cancelled'].includes(stage));
  const live=(rows:RecordRow[]=[])=>rows.filter(row=>!row.deletedAt&&!row.archivedAt);
  return <div className="project-progress-grid">{projects.length?projects.map(project=>{
    const progress=Math.min(100,Math.max(0,Number(project.progress)||0));
    const updates=live(store.projectPosts).filter(post=>post.project===project.id&&!post.parent).sort((a,b)=>String(b.postedAt||b.createdAt).localeCompare(String(a.postedAt||a.createdAt)));
    const tasks=live(store.tasks).filter(task=>task.project===project.id),done=tasks.filter(task=>task.status==='Completed');
    const customer=store.customers?.find(row=>row.id===project.customer),site=store.sites?.find(row=>row.id===project.site);
    const stageIndex=phases.indexOf(project.status),latest=updates[0];
    const state=project.status==='Completed'?'complete':project.status==='On Hold'?'hold':project.status==='Cancelled'?'cancelled':'active';
    return <button type="button" className={`project-progress-card project-${state}`} key={project.id} onClick={()=>open(project)} aria-label={`Open progress for ${project.name}`}>
      <div className="project-card-heading"><span className="project-card-mark"><Milestone size={20}/></span><span className="project-card-status">{project.status||'Planning'}</span><ArrowUpRight className="project-card-open" size={17}/></div>
      <h3>{project.name}</h3><p className="project-card-client">{customer?.name||site?.name||'Project workspace'}</p>
      <div className="project-card-progress-label"><span>Delivery progress</span><strong>{progress}%</strong></div>
      <div className="project-card-track" role="progressbar" aria-label={`${project.name} delivery progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><i style={{width:`${progress}%`}}/></div>
      {phases.length>0&&<div className="project-card-phases" aria-label={`Current stage: ${project.status||'Planning'}`}>{phases.map((phase,index)=><i key={phase} title={phase} className={stageIndex>=index?'reached':''}/>)}</div>}
      <div className="project-card-meta">{(project.city||site?.city)&&<span><MapPin size={13}/>{project.city||site?.city}</span>}{project.dueDate&&<span><CalendarClock size={13}/>{new Date(project.dueDate+'T12:00:00').toLocaleDateString('en-IN',{day:'numeric',month:'short'})}</span>}<span><CheckCircle2 size={13}/>{done.length}/{tasks.length} tasks</span></div>
      <div className="project-card-update"><div><MessageSquare size={13}/><span>{updates.length} {updates.length===1?'post':'posts'}</span><span className="project-card-latest-author">{latest?.authorName||'Open project feed'}</span></div><p>{latest?.body||(!latest?'Share installation progress, comments, photos and videos.':latest.media?.length?'New media shared with the project.':'Project progress updated.')}</p></div>
      <div className="project-card-footer"><span>View progress & conversation</span><ArrowUpRight size={14}/></div>
    </button>;
  }):<div className="project-cards-empty"><Milestone size={30}/><strong>No projects match this view</strong><p>Adjust your filters or create a project to start tracking delivery.</p></div>}</div>;
}
