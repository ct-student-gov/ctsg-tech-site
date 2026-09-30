const form = document.getElementById("event-submission-form");
const field = name => form.elements.namedItem(name);
const type = field("submissionType");
const description = field("description");
const url = field("url");
const endDate = field("endDate");
const endTime = field("endTime");
const preview = document.getElementById("submission-preview");

function updateQuestions() {
  const external = type.value === "external";
  document.getElementById("organizer-label").textContent = type.value === "club" ? "Club name *" : "Organizer or organization *";
  document.getElementById("event-url-label").textContent = external ? "Official event or registration link *" : "Official event or registration link (optional)";
  url.required = external;
  document.getElementById("submission-guidance").textContent = {
    club: "Share your club’s event details here as part of its normal CTSG review process.",
    ctsg: "Enter CTSG as the organizer. The event will still need review before publication.",
    student: "You don’t need to be part of a club to propose an event. Use your name or organizing group as the organizer.",
    external: "For example, an NYC hackathon, talk, or workshop. Name the actual host and include its official event page; you don’t have to be the organizer.",
  }[type.value] || "";
  const allDay = field("allDay").checked;
  for (const id of ["start-time-field", "end-time-field"]) document.getElementById(id).hidden = allDay;
  field("startTime").disabled = allDay;
  endTime.disabled = allDay;
  field("startTime").required = !allDay;
}

function validate() {
  description.setCustomValidity(description.value.trim().split(/\s+/).filter(Boolean).length > 100 ? "Keep the description to 100 words or fewer." : "");
  url.setCustomValidity(url.value && !/^https?:\/\//i.test(url.value) ? "Enter a link beginning with https:// or http://." : "");
  endDate.setCustomValidity(endDate.value && endDate.value < field("startDate").value ? "The end date must be on or after the start date." : "");
  const start = `${field("startDate").value}T${field("startTime").value}`;
  const end = `${endDate.value || field("startDate").value}T${endTime.value}`;
  endTime.setCustomValidity(!field("allDay").checked && endTime.value && end <= start ? "The end time must be after the start time. Set an end date for an overnight event." : "");
}

function showDetails(id, values) {
  const list = document.getElementById(id);
  list.replaceChildren();
  for (const [label, value] of values) {
    if (!value) continue;
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = value;
    list.append(term, detail);
  }
}

form.addEventListener("input", () => { preview.hidden = true; updateQuestions(); validate(); });
form.addEventListener("change", () => { preview.hidden = true; updateQuestions(); validate(); });
form.addEventListener("submit", event => {
  event.preventDefault();
  validate();
  if (!form.reportValidity()) return;
  const allDay = field("allDay").checked;
  showDetails("public-preview", [
    ["Event title", field("title").value],
    ["Organizer", field("organizer").value],
    ["Description", description.value],
    ["Location", field("location").value],
    ["Starts", `${field("startDate").value}${allDay ? " (all day)" : ` ${field("startTime").value} (New York time)`}`],
    ["Ends", allDay ? (endDate.value || field("startDate").value) : endTime.value ? `${endDate.value || field("startDate").value} ${endTime.value} (New York time)` : endDate.value ? `${endDate.value} (end time not specified)` : "Not specified"],
    ["Official event link", url.value],
    ["Image", field("image").files[0]?.name],
  ]);
  showDetails("private-preview", [
    ["Submission type", type.selectedOptions[0].textContent],
    ["Submitter", field("submitterName").value],
    ["Email", field("submitterEmail").value],
    ["Notes", field("notes").value],
    ["Review status", "Pending — preview only"],
  ]);
  preview.hidden = false;
  preview.focus();
});
updateQuestions();
document.getElementById("preview-submission").disabled = false;
