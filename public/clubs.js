// Render plain text safely, making complete HTTP(S) joining URLs clickable.
function appendText(parent, text) {
  for (const part of text.split(/(https?:\/\/[^\s<>]+)/g)) {
    let url;
    try { url = new URL(part); } catch {}
    if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      parent.append(document.createTextNode(part));
      continue;
    }
    const link = document.createElement("a");
    link.href = url.href;
    link.textContent = part;
    parent.append(link);
  }
}

export function renderClubs(root, data) {
  const fragment = document.createDocumentFragment();
  if (!data.clubs.length) {
    const message = document.createElement("p");
    message.textContent = "Club information will be available here soon.";
    fragment.append(message);
  }
  for (const club of data.clubs) {
    const article = document.createElement("article");
    article.className = "club-row";
    const heading = document.createElement("h2");
    heading.className = "club-name";
    heading.textContent = club.name;
    article.append(heading);
    const overview = document.createElement("div");
    overview.className = "club-overview";
    for (const paragraph of club.description.split(/\n+/).filter(Boolean)) {
      const p = document.createElement("p");
      p.textContent = paragraph;
      overview.append(p);
    }
    if (club.joining || club.links) {
      const joining = document.createElement("div");
      joining.className = "club-joining";
      const title = document.createElement("h3");
      title.className = "eyebrow";
      title.textContent = "How to join";
      joining.append(title);
      for (const text of [club.joining, club.links].filter(Boolean)) {
        const p = document.createElement("p");
        appendText(p, text);
        joining.append(p);
      }
      overview.append(joining);
    }
    article.append(overview);
    if (club.officers.length) {
      const list = document.createElement("dl");
      list.className = "club-officers";
      for (const officer of club.officers) {
        const entry = document.createElement("div");
        const role = document.createElement("dt");
        role.textContent = officer.role;
        const name = document.createElement("dd");
        name.textContent = officer.name;
        entry.append(role, name);
        list.append(entry);
      }
      article.append(list);
    }
    fragment.append(article);
  }
  root.replaceChildren(fragment);
}
