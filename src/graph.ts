/**
 * Work graph over the session catalog (WG-M5-lite).
 *
 * Git dimensions:
 *   session --worked-in--> work git (cwd walk-up, observed)
 *   session --touched--> touch git (tool paths, observed)  ← yarn / requirement
 *   session --landed-in--> commit(session_commits 表;declared trailer / candidate 时间窗)
 *   session --has-requirement--> first long user request
 *   requirement --in-project--> first touch git (unmapped if none)
 *
 * Work git is never used as the requirement's project.
 */
import type {
  SessionCommit,
  SessionRecord,
  SessionRepo,
  WorkEdge,
  WorkGraph,
  WorkNode,
  WorkProject,
  WorkRequirement,
} from './types.ts';
import {
  projectIdOfRepo,
  sessionProjectId,
  UNMAPPED_PROJECT,
} from './repos.ts';

function reposOf(session: SessionRecord): SessionRepo[] {
  if (session.repos && session.repos.length > 0) return session.repos;
  if (!session.gitUrl && !session.gitRoot) return [];
  return [{
    sessionId: session.id,
    role: 'work',
    url: session.gitUrl || session.gitRoot || session.cwd || '(unknown)',
    root: session.gitRoot || session.gitUrl || session.cwd || '(unknown)',
    name: session.gitName || session.gitRoot || '(unknown)',
    evidenceKind: 'observed',
  }];
}

function ensureProject(
  projects: Map<string, WorkProject>,
  nodes: WorkNode[],
  repo: { url: string; root?: string | null; name: string },
): WorkProject {
  const id = projectIdOfRepo(repo);
  let project = projects.get(id);
  if (!project) {
    project = {
      id,
      name: repo.name,
      root: repo.root ?? null,
      url: repo.url,
      sessionCount: 0,
      providers: [],
      requirements: [],
    };
    projects.set(id, project);
    nodes.push({ id: `project:${id}`, kind: 'project', label: repo.name });
  }
  return project;
}

function addSessionToProject(project: WorkProject, session: SessionRecord): void {
  project.sessionCount += 1;
  if (!project.providers.includes(session.provider)) project.providers.push(session.provider);
}

export function buildWorkGraph(
  sessions: SessionRecord[],
  requirements?: Map<string, string>,
  commits?: SessionCommit[],
  includeSubagents = false,
): WorkGraph {
  const nodes: WorkNode[] = [];
  const edges: WorkEdge[] = [];
  const projects = new Map<string, WorkProject>();
  const counted = new Map<string, Set<string>>();

  // subagent 派工 session(claude 布局:source_file 路径含 /subagents/)的
  // 「需求」是父 agent 的派工 prompt,不是用户意图,默认不进图;其它 provider
  // 出现类似布局时在此扩展。project 计数、requirement、commit 边同步排除。
  const visible = includeSubagents
    ? sessions
    : sessions.filter((session) => !session.sourceFile?.includes('/subagents/'));

  const noteSession = (project: WorkProject, session: SessionRecord): void => {
    const seen = counted.get(project.id) ?? new Set<string>();
    if (seen.has(session.id)) return;
    seen.add(session.id);
    counted.set(project.id, seen);
    addSessionToProject(project, session);
  };

  for (const session of visible) {
    const repos = reposOf(session);
    const work = repos.filter((repo) => repo.role === 'work');
    const touch = repos.filter((repo) => repo.role === 'touch');
    const commit = repos.filter((repo) => repo.role === 'commit');

    nodes.push({
      id: session.id,
      kind: 'session',
      label: session.title || session.nativeId,
      provider: session.provider,
      sessionId: session.id,
    });

    for (const repo of work) {
      const project = ensureProject(projects, nodes, repo);
      if (!project.root && repo.root) project.root = repo.root;
      if (!project.url && repo.url) project.url = repo.url;
      noteSession(project, session);
      edges.push({
        from: session.id,
        to: `project:${project.id}`,
        kind: 'worked-in',
        evidenceKind: 'observed',
      });
    }

    for (const repo of touch) {
      const project = ensureProject(projects, nodes, repo);
      if (!project.root && repo.root) project.root = repo.root;
      if (!project.url && repo.url) project.url = repo.url;
      noteSession(project, session);
      edges.push({
        from: session.id,
        to: `project:${project.id}`,
        kind: 'touched',
        evidenceKind: 'observed',
      });
    }

    for (const repo of commit) {
      const project = ensureProject(projects, nodes, repo);
      noteSession(project, session);
      edges.push({
        from: session.id,
        to: `project:${project.id}`,
        kind: 'landed-in',
        evidenceKind: repo.evidenceKind,
      });
    }

    // Legacy catalog rows with only cwd git and no repos[] still get a
    // worked-in node so the graph is not empty, but that is work git.
    if (repos.length === 0 && (session.gitUrl || session.gitRoot || session.cwd)) {
      const id = sessionProjectId(session);
      const name = session.gitName || session.gitRoot || session.cwd || '(unknown)';
      const project = ensureProject(projects, nodes, {
        url: session.gitUrl || id,
        root: session.gitRoot ?? null,
        name,
      });
      noteSession(project, session);
      edges.push({
        from: session.id,
        to: `project:${project.id}`,
        kind: 'worked-in',
        evidenceKind: 'observed',
      });
    }

    // 需求文本:优先消息流抽取(motivation v2),没有再退回 head 解析的 title
    const text = requirements?.get(session.id)?.trim() || session.title?.trim();
    if (!text) continue;
    const reqId = `req:${session.id}`;
    const touchProject = touch[0];
    const requirement: WorkRequirement = {
      id: reqId,
      sessionId: session.id,
      text,
      provider: session.provider,
      project: touchProject?.name ?? UNMAPPED_PROJECT,
      updatedAt: session.updatedAt,
    };
    nodes.push({
      id: reqId,
      kind: 'requirement',
      label: text,
      provider: session.provider,
      sessionId: session.id,
    });
    edges.push({
      from: session.id,
      to: reqId,
      kind: 'has-requirement',
      evidenceKind: 'observed',
    });
    if (touchProject) {
      const project = ensureProject(projects, nodes, touchProject);
      project.requirements.push(requirement);
      edges.push({
        from: reqId,
        to: `project:${project.id}`,
        kind: 'in-project',
        evidenceKind: 'observed',
      });
    }
  }

  // commit 归因(session_commits 表):session --landed-in--> commit --> in-project
  // commit 的 repo url 与 session_repos.url 一致,project id 因而对齐已有 project 节点
  const sessionIds = new Set(visible.map((session) => session.id));
  for (const commit of commits ?? []) {
    if (!sessionIds.has(commit.sessionId)) continue;
    const nodeId = `commit:${commit.sha}`;
    nodes.push({
      id: nodeId,
      kind: 'commit',
      label: commit.summary || commit.sha.slice(0, 8),
      sessionId: commit.sessionId,
      fileOverlap: commit.fileOverlap,
    });
    edges.push({
      from: commit.sessionId,
      to: nodeId,
      kind: 'landed-in',
      evidenceKind: commit.kind === 'declared' ? 'declared' : 'candidate',
    });
    const projectId = projectIdOfRepo({ url: commit.repo });
    if (projects.has(projectId)) {
      edges.push({
        from: nodeId,
        to: `project:${projectId}`,
        kind: 'in-project',
        evidenceKind: 'observed',
      });
    }
  }

  const projectList = [...projects.values()]
    .map((project) => ({
      ...project,
      providers: [...project.providers].sort(),
      requirements: [...project.requirements].sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .sort((a, b) => b.sessionCount - a.sessionCount || a.name.localeCompare(b.name));

  return { projects: projectList, nodes, edges };
}
