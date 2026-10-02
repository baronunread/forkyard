import { z } from "zod";

/** Where you are on a task page, kept in the URL: ?agent=&file=&view= */
export const TASK_VIEWS = ["changes", "compare", "activity", "decide"] as const;
export const TaskSearch = z.object({
  agent: z.string().optional(),
  file: z.string().optional(),
  view: z.enum(TASK_VIEWS).optional(),
});
export type TaskSearch = z.infer<typeof TaskSearch>;
