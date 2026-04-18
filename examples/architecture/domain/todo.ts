/** Domain entity — pure data, no framework dependencies. */
export interface Todo {
  id: string;
  title: string;
  completed: boolean;
  createdAt: Date;
}
