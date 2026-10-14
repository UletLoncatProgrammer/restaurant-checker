// Kitchen stations. Every dish goes to one of these (set in Admin > Menu):
//   KITCHEN = hot kitchen, COLD = cold kitchen, BAR = bar.
// The restaurant's kitchen mode decides which screens exist:
//   ONE   = one kitchen screen shows hot AND cold dishes ("Hot & Cold Kitchen")
//   SPLIT = "Hot Kitchen" and "Cold Kitchen" are separate screens
// The Bar always has its own screen.

export const STATIONS = ["KITCHEN", "COLD", "BAR"];

// Which stations a screen ("board") shows.
export function boardStations(board, mode) {
  if (board === "bar") return ["BAR"];
  if (board === "cold") return ["COLD"];
  return mode === "SPLIT" ? ["KITCHEN"] : ["KITCHEN", "COLD"];
}

// The name of a screen, as shown in its title and in the top menu.
export function boardTitle(board, mode) {
  if (board === "bar") return "Bar";
  if (board === "cold") return "Cold Kitchen";
  return mode === "SPLIT" ? "Hot Kitchen" : "Hot & Cold Kitchen";
}

// The name of a station in menus and forms.
export function stationName(station) {
  return { KITCHEN: "Hot kitchen", COLD: "Cold kitchen", BAR: "Bar" }[station] || "Hot kitchen";
}

// Lines sent before stations existed have no station: they belong to the hot kitchen.
export const stationOf = (item) => item.station || "KITCHEN";
