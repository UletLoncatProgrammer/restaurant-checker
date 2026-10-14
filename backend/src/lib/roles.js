// One place that says who may do what. Routes import these instead of
// repeating role lists, so a permission change is a one-line edit.
const ROLES = {
  TAKE_ORDER: ["FOH", "COORDINATOR", "SUPERVISOR", "ADMIN"],
  KITCHEN_STATUS: ["KITCHEN", "COORDINATOR", "SUPERVISOR", "ADMIN"], // PENDING->PREPARING->READY
  DELIVER: ["FOH", "COORDINATOR", "SUPERVISOR", "ADMIN"], // READY->DELIVERED
  PAY: ["FOH", "COORDINATOR", "SUPERVISOR", "ADMIN"],
  VOID: ["SUPERVISOR", "ADMIN"], // deliberately NOT coordinator/FOH
  OVERSEE: ["COORDINATOR", "SUPERVISOR", "ADMIN"], // transactions + activity feed + stock
  EXPORT: ["COORDINATOR", "ADMIN"], // Excel report
};

module.exports = { ROLES };
