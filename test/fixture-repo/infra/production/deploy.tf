# Production infrastructure. Under infra/ and owned by `infra`, but
# protected_denies.write lists infra/production/**, so NO delegation may write
# here — a protected deny is non-overridable in advisory and enforce alike.
resource "null_resource" "production" {
  triggers = {
    environment = "production"
  }
}
