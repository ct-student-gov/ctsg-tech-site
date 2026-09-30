function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function appendRichText(node, parts = []) {
  for (const part of parts) {
    let run = document.createTextNode(part.text);
    for (const [flag, tag] of [["code", "code"], ["bold", "strong"], ["italic", "em"], ["strikethrough", "s"], ["underline", "u"]]) {
      if (part[flag]) { const wrapper = element(tag); wrapper.append(run); run = wrapper; }
    }
    if (part.href) {
      try {
        const url = new URL(part.href);
        if (["https:", "http:", "mailto:"].includes(url.protocol)) {
          const link = element("a"); link.href = url.href; link.append(run); run = link;
        }
      } catch {}
    }
    node.append(run);
  }
}

function imageNode(image, className, alt = image.alt) {
  const node = element("img", className);
  node.src = image.src;
  node.alt = alt;
  if (image.width) node.width = image.width;
  if (image.height) node.height = image.height;
  node.loading = "lazy";
  return node;
}

export function renderBlog(list, data) {
  const fragment = document.createDocumentFragment();
  const formatter = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  for (const post of data.posts) {
    const id = `blog-${post.id}`;
    const dateLabel = formatter.format(new Date(`${post.date}T00:00:00Z`));
    const time = className => {
      const node = element("time", className, dateLabel); node.dateTime = post.date; return node;
    };
    const item = element("li"), article = element("article"), heading = element("h3");
    const button = element("button", "event-card"); button.type = "button";
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-controls", `${id}-details`);
    button.setAttribute("aria-labelledby", `${id}-title`);
    if (post.images.length) button.append(imageNode(post.images[0], "event-card-image"));
    const title = element("span", "event-card-title", post.title); title.id = `${id}-title`;
    const action = element("span", "event-card-action", post.action || "Read post");
    const plus = element("span", null, "+"); plus.setAttribute("aria-hidden", "true"); action.append(plus);
    button.append(title, time("event-card-date"), action); heading.append(button);
    const dialog = element("dialog", "event-details"); dialog.id = `${id}-details`;
    dialog.setAttribute("aria-labelledby", `${id}-details-title`);
    const closeForm = element("form", "event-details-close"); closeForm.method = "dialog";
    const close = element("button"); close.type = "submit"; close.autofocus = true; close.setAttribute("aria-label", "Close");
    const cross = element("span", null, "×"); cross.setAttribute("aria-hidden", "true"); close.append(cross);
    closeForm.append(close); dialog.append(closeForm);
    if (post.images.length) {
      const gallery = element("div", "event-gallery"); gallery.tabIndex = 0;
      gallery.setAttribute("role", "region"); gallery.setAttribute("aria-label", `${post.title} images`);
      for (const image of post.images) {
        const figure = element("figure"), caption = element("figcaption");
        caption.append(element("span", null, image.caption || ""));
        if (image.credit) caption.append(element("span", "event-photo-credit", image.credit));
        figure.append(imageNode(image), caption); gallery.append(figure);
      }
      dialog.append(gallery);
    }
    const body = element("div", "event-details-body"), detailTitle = element("h2", null, post.title);
    detailTitle.id = `${id}-details-title`;
    const dateLine = element("p", "eyebrow"); dateLine.append(time()); body.append(detailTitle, dateLine);
    let currentList = null, listType = null;
    for (const block of post.body) {
      const tag = { paragraph: "p", heading_1: "h3", heading_2: "h3", heading_3: "h4", quote: "blockquote", code: "pre", divider: "hr", bulleted_list_item: "ul", numbered_list_item: "ol" }[block.type];
      if (!tag) continue;
      let node;
      if (["ul", "ol"].includes(tag)) {
        if (listType !== tag) { currentList = element(tag); body.append(currentList); }
        listType = tag; node = element("li"); currentList.append(node);
      } else { listType = null; node = element(tag); body.append(node); }
      appendRichText(node, block.richText);
    }
    dialog.append(body); article.append(heading, dialog); item.append(article); fragment.append(item);
  }
  list.replaceChildren(fragment);
}
