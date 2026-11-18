import { createContext, useContext } from "react";

export interface TaskChatRewindApi {
  canRewind: (commentId: string) => boolean;
  rewindTo: (commentId: string) => void;
}

export const TaskChatRewindContext = createContext<TaskChatRewindApi | null>(null);

export function useTaskChatRewind(): TaskChatRewindApi | null {
  return useContext(TaskChatRewindContext);
}
