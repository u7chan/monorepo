import { useCallback, useRef, useState } from "react";
import {
  createProject as apiCreateProject,
  deleteProject as apiDeleteProject,
  listProjects,
  type CreateProjectInput,
} from "../api";
import type { Project } from "../types";
import { createRequestGate } from "./requestGate";

const PROJECT_KEY = "u7agent-project";
const alwaysCurrent = () => true;

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectIdState] = useState<string>(
    () => localStorage.getItem(PROJECT_KEY) || "",
  );
  const projectsRef = useRef<Project[]>([]);
  const selectedProjectIdRef = useRef(selectedProjectId);
  selectedProjectIdRef.current = selectedProjectId;

  /** ensureSession が送信時に読むため、state の反映を待たず ref も更新する */
  const selectProject = useCallback((id: string): void => {
    selectedProjectIdRef.current = id;
    setSelectedProjectIdState(id);
    localStorage.setItem(PROJECT_KEY, id);
  }, []);

  const [beginProjectsRequest] = useState(createRequestGate);
  const refreshProjects = useCallback(
    async (isCurrent = alwaysCurrent): Promise<Project[]> => {
      const canApply = beginProjectsRequest(isCurrent);
      try {
        const { projects: list } = await listProjects();
        if (!canApply()) return list;
        projectsRef.current = list;
        setProjects(list);
        // 選択が消えていたら未所属へ戻す (存在しない作成先を使い続けない)
        if (selectedProjectIdRef.current && !list.some((project) => project.id === selectedProjectIdRef.current)) {
          selectProject("");
        }
        return list;
      } catch {
        return projectsRef.current;
      }
    },
    [beginProjectsRequest, selectProject],
  );

  const createProject = useCallback(
    async (input: CreateProjectInput): Promise<Project> => {
      const { project } = await apiCreateProject(input);
      // 進行中の一覧取得を無効化する。遅れて成功した古い一覧が、作成直後の一覧と選択を上書きしないため
      beginProjectsRequest();
      const list = [...projectsRef.current.filter((item) => item.id !== project.id), project];
      projectsRef.current = list;
      setProjects(list);
      selectProject(project.id);
      return project;
    },
    [beginProjectsRequest, selectProject],
  );

  /** 解除できたかを返す。配下セッションの表示回復は呼び出し元 (facade) が行う */
  const deleteProject = useCallback(
    async (projectId: string): Promise<boolean> => {
      try {
        await apiDeleteProject(projectId);
      } catch (error) {
        console.error(error);
        return false;
      }
      await refreshProjects();
      return true;
    },
    [refreshProjects],
  );

  const selectedProject = projects.find((project) => project.id === selectedProjectId);

  return {
    projects,
    selectedProjectId,
    selectedProjectIdRef,
    selectedProject,
    selectProject,
    refreshProjects,
    createProject,
    deleteProject,
  };
}
