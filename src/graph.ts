/**
 * Work graph over the session catalog (WG-M5-lite).
 *
 * Deterministic / observed only:
 *   session --in-project--> git repo (cwd walk-up)
 *   session --has-requirement--> first long user request (catalog title)
 * Semantic clustering, chat search, and declared edges are out of scope.
 */
import type {
  SessionRecord,
  WorkEdge,
  WorkGraph,
  WorkNode,
  WorkProject,
  WorkRequirement,
} from './types.ts';
import { sessionProject, sessionProjectId } from './repos.ts';

export function buildWorkGraph(sessions: SessionRecord[]): WorkGraph {
  const nodes: WorkNode[] = [];
  const edges: WorkEdge[] = [];
  const projects = new Map<string, WorkProject>();

  for (const session of sessions) {
    const projectId = sessionProjectId(session);
    const projectName = sessionProject(session);
    let project = projects.get(projectId);
    if (!project) {
      project = {
        id: projectId,
        name: projectName,
        root: session.gitRoot ?? null,
        url: session.gitUrl ?? null,
        sessionCount: 0,
        providers: [],
        requirements: [],
      };
      projects.set(projectId, project);
      nodes.push({ id: `project:${projectId}`, kind: 'project', label: projectName });
    }
    project.sessionCount += 1;
    if (!project.providers.includes(session.provider)) project.providers.push(session.provider);
    if (!project.root && session.gitRoot) project.root = session.gitRoot;
    if (!project.url && session.gitUrl) project.url = session.gitUrl;

    nodes.push({
      id: session.id,
      kind: 'session',
      label: session.title || session.nativeId,
      provider: session.provider,
      sessionId: session.id,
    });
    edges.push({
      from: session.id,
      to: `project:${projectId}`,
      kind: 'in-project',
      evidenceKind: 'observed',
    });

    const text = session.title?.trim();
    if (text) {
      const reqId = `req:${session.id}`;
      const requirement: WorkRequirement = {
        id: reqId,
        sessionId: session.id,
        text,
        provider: session.provider,
        project: projectName,
        updatedAt: session.updatedAt,
      };
      project.requirements.push(requirement);
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
      edges.push({
        from: reqId,
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
