{{- define "flakey.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "flakey.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "flakey.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "flakey.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "flakey.selectorLabels" -}}
app.kubernetes.io/name: {{ include "flakey.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "flakey.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- include "flakey.fullname" . -}}
{{- else -}}
{{- default "default" -}}
{{- end -}}
{{- end -}}

{{/* Database host — use bundled PostgreSQL if enabled */}}
{{- define "flakey.dbHost" -}}
{{- if .Values.postgresql.enabled -}}
{{- printf "%s-postgresql" .Release.Name -}}
{{- else -}}
{{- .Values.database.host -}}
{{- end -}}
{{- end -}}

{{/* Secret name for sensitive values */}}
{{- define "flakey.secretName" -}}
{{- if .Values.auth.existingSecret -}}
{{- .Values.auth.existingSecret -}}
{{- else -}}
{{- include "flakey.fullname" . -}}
{{- end -}}
{{- end -}}

{{/* Database secret name */}}
{{- define "flakey.dbSecretName" -}}
{{- if .Values.database.existingSecret -}}
{{- .Values.database.existingSecret -}}
{{- else -}}
{{- include "flakey.fullname" . -}}-db
{{- end -}}
{{- end -}}
