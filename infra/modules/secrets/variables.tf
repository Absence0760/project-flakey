variable "app_name" { type = string }
variable "environment" { type = string }

# Opt-in overrides for the three app secrets. Empty (the default) means the
# module generates the secret with random_* — the zero-config self-hoster path.
# When non-empty (supplied from a sops-encrypted file at the root, see
# infra/main.tf), the provided value is used verbatim instead. The module stays
# provider-agnostic: it receives plain strings, not a sops data source.
variable "jwt_secret_override" {
  type      = string
  default   = ""
  sensitive = true
}
variable "encryption_key_override" {
  type      = string
  default   = ""
  sensitive = true
}
variable "db_app_password_override" {
  type      = string
  default   = ""
  sensitive = true
}
