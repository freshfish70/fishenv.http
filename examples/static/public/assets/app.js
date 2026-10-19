const res = await fetch("/api/todos");
const list = document.getElementById("todos");
for (const todo of await res.json()) {
  const li = document.createElement("li");
  li.textContent = `${todo.title} (route: ${location.pathname})`;
  list.append(li);
}
