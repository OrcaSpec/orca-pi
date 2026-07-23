# Infrastructure root. Owned by `infra`. Writable by the infra agent.
# The steward's discovery scope does NOT include infra/**, so the steward
# cannot read here directly — infra work goes through delegation.
resource "null_resource" "app" {
  triggers = {
    name = "orca-dogfood"
  }
}
