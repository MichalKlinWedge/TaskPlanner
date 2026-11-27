
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "activity_log": {
                  Row: {
                    "actor_id": string | null,"at": string,"changes": NonNullable<Json>,"device_id": string | null,"id": number,"row_id": string,"scope_id": string,"source": Json | null,"table_name": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id"?: string | null,"at"?: string,"changes": NonNullable<Json>,"device_id"?: string | null,"id"?: never,"row_id": string,"scope_id": string,"source"?: Json | null,"table_name": string
                  }
                  Update: {
                    "actor_id"?: string | null,"at"?: string,"changes"?: NonNullable<Json>,"device_id"?: string | null,"id"?: never,"row_id"?: string,"scope_id"?: string,"source"?: Json | null,"table_name"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "activity_log_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    }
                  ]
                },"ai_accounts": {
                  Row: {
                    "billing_confirmed_at": string,"created_at": string,"deleted_at": string | null,"id": string,"key_hint": string | null,"last_error": string | null,"model": string | null,"models": NonNullable<Json>,"provider": string,"row_version": number,"secret_id": string | null,"status": string,"updated_at": string,"user_id": string,"verified_at": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "billing_confirmed_at": string,"created_at"?: string,"deleted_at"?: string | null,"id"?: string,"key_hint"?: string | null,"last_error"?: string | null,"model"?: string | null,"models"?: NonNullable<Json>,"provider": string,"row_version"?: number,"secret_id"?: string | null,"status"?: string,"updated_at"?: string,"user_id": string,"verified_at"?: string | null
                  }
                  Update: {
                    "billing_confirmed_at"?: string,"created_at"?: string,"deleted_at"?: string | null,"id"?: string,"key_hint"?: string | null,"last_error"?: string | null,"model"?: string | null,"models"?: NonNullable<Json>,"provider"?: string,"row_version"?: number,"secret_id"?: string | null,"status"?: string,"updated_at"?: string,"user_id"?: string,"verified_at"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"allowed_emails": {
                  Row: {
                    "created_at": string,"note": string | null,"pattern": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"note"?: string | null,"pattern": string
                  }
                  Update: {
                    "created_at"?: string,"note"?: string | null,"pattern"?: string
                  }
                  Relationships: [
                    
                  ]
                },"app_admins": {
                  Row: {
                    "created_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"attachments": {
                  Row: {
                    "created_at": string,"created_by": string | null,"deleted_at": string | null,"field_clock": NonNullable<Json>,"id": string,"kind": string,"mime": string | null,"name": string,"preview": Json | null,"row_version": number,"scope_id": string,"size_bytes": number | null,"storage_path": string | null,"task_id": string,"updated_at": string,"url": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id": string,"kind": string,"mime"?: string | null,"name": string,"preview"?: Json | null,"row_version"?: number,"scope_id": string,"size_bytes"?: number | null,"storage_path"?: string | null,"task_id": string,"updated_at"?: string,"url"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id"?: string,"kind"?: string,"mime"?: string | null,"name"?: string,"preview"?: Json | null,"row_version"?: number,"scope_id"?: string,"size_bytes"?: number | null,"storage_path"?: string | null,"task_id"?: string,"updated_at"?: string,"url"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "attachments_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "attachments_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"calendar_accounts": {
                  Row: {
                    "created_at": string,"external_id": string,"id": string,"label": string,"last_error": string | null,"last_synced_at": string | null,"provider": string,"row_version": number,"secret_id": string | null,"status": string,"sync_state": NonNullable<Json>,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"external_id": string,"id"?: string,"label": string,"last_error"?: string | null,"last_synced_at"?: string | null,"provider": string,"row_version"?: number,"secret_id"?: string | null,"status"?: string,"sync_state"?: NonNullable<Json>,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"external_id"?: string,"id"?: string,"label"?: string,"last_error"?: string | null,"last_synced_at"?: string | null,"provider"?: string,"row_version"?: number,"secret_id"?: string | null,"status"?: string,"sync_state"?: NonNullable<Json>,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"calendar_events": {
                  Row: {
                    "all_day": boolean,"calendar_id": string,"created_at": string,"deleted_at": string | null,"end_at": string | null,"end_date": string | null,"etag": string | null,"external_id": string,"id": string,"location": string | null,"row_version": number,"start_at": string | null,"start_date": string | null,"task_id": string | null,"title": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "all_day"?: boolean,"calendar_id": string,"created_at"?: string,"deleted_at"?: string | null,"end_at"?: string | null,"end_date"?: string | null,"etag"?: string | null,"external_id": string,"id"?: string,"location"?: string | null,"row_version"?: number,"start_at"?: string | null,"start_date"?: string | null,"task_id"?: string | null,"title"?: string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "all_day"?: boolean,"calendar_id"?: string,"created_at"?: string,"deleted_at"?: string | null,"end_at"?: string | null,"end_date"?: string | null,"etag"?: string | null,"external_id"?: string,"id"?: string,"location"?: string | null,"row_version"?: number,"start_at"?: string | null,"start_date"?: string | null,"task_id"?: string | null,"title"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "calendar_events_calendar_id_fkey"
      columns: ["calendar_id"]
isOneToOne: false
      referencedRelation: "calendars"
      referencedColumns: ["id"]
    }
                  ]
                },"calendar_task_links": {
                  Row: {
                    "calendar_id": string,"etag": string | null,"external_id": string,"pushed": NonNullable<Json>,"task_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "calendar_id": string,"etag"?: string | null,"external_id": string,"pushed": NonNullable<Json>,"task_id": string,"updated_at"?: string
                  }
                  Update: {
                    "calendar_id"?: string,"etag"?: string | null,"external_id"?: string,"pushed"?: NonNullable<Json>,"task_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "calendar_task_links_calendar_id_fkey"
      columns: ["calendar_id"]
isOneToOne: false
      referencedRelation: "calendars"
      referencedColumns: ["id"]
    }
                  ]
                },"calendar_task_runs": {
                  Row: {
                    "calendar_id": string,"expires_at": string | null,"holder": string | null,"rerun": boolean
                  }
                  ComputedFields: never
                  Insert: {
                    "calendar_id": string,"expires_at"?: string | null,"holder"?: string | null,"rerun"?: boolean
                  }
                  Update: {
                    "calendar_id"?: string,"expires_at"?: string | null,"holder"?: string | null,"rerun"?: boolean
                  }
                  Relationships: [
                    {
      foreignKeyName: "calendar_task_runs_calendar_id_fkey"
      columns: ["calendar_id"]
isOneToOne: true
      referencedRelation: "calendars"
      referencedColumns: ["id"]
    }
                  ]
                },"calendars": {
                  Row: {
                    "account_id": string,"color": string | null,"created_at": string,"external_id": string,"id": string,"is_task_target": boolean,"last_synced_at": string | null,"name": string,"row_version": number,"sync_state": NonNullable<Json>,"updated_at": string,"user_id": string,"visible": boolean
                  }
                  ComputedFields: never
                  Insert: {
                    "account_id": string,"color"?: string | null,"created_at"?: string,"external_id": string,"id"?: string,"is_task_target"?: boolean,"last_synced_at"?: string | null,"name": string,"row_version"?: number,"sync_state"?: NonNullable<Json>,"updated_at"?: string,"user_id": string,"visible"?: boolean
                  }
                  Update: {
                    "account_id"?: string,"color"?: string | null,"created_at"?: string,"external_id"?: string,"id"?: string,"is_task_target"?: boolean,"last_synced_at"?: string | null,"name"?: string,"row_version"?: number,"sync_state"?: NonNullable<Json>,"updated_at"?: string,"user_id"?: string,"visible"?: boolean
                  }
                  Relationships: [
                    {
      foreignKeyName: "calendars_account_id_fkey"
      columns: ["account_id"]
isOneToOne: false
      referencedRelation: "calendar_accounts"
      referencedColumns: ["id"]
    }
                  ]
                },"client_errors": {
                  Row: {
                    "app_version": string | null,"context": NonNullable<Json>,"count": number,"day": string,"fingerprint": string,"first_at": string,"id": number,"kind": string,"last_at": string,"message": string,"platform": string,"received_at": string,"stack": string | null,"url": string | null,"user_agent": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "app_version"?: string | null,"context"?: NonNullable<Json>,"count"?: number,"day": string,"fingerprint": string,"first_at": string,"id"?: never,"kind": string,"last_at": string,"message": string,"platform": string,"received_at"?: string,"stack"?: string | null,"url"?: string | null,"user_agent"?: string | null,"user_id": string
                  }
                  Update: {
                    "app_version"?: string | null,"context"?: NonNullable<Json>,"count"?: number,"day"?: string,"fingerprint"?: string,"first_at"?: string,"id"?: never,"kind"?: string,"last_at"?: string,"message"?: string,"platform"?: string,"received_at"?: string,"stack"?: string | null,"url"?: string | null,"user_agent"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"collaborators": {
                  Row: {
                    "acronym": string | null,"archived_at": string | null,"color": string | null,"created_at": string,"created_by": string | null,"deleted_at": string | null,"email": string | null,"field_clock": NonNullable<Json>,"id": string,"name": string,"row_version": number,"scope_id": string,"updated_at": string,"workspace_ids": Json | null
                  }
                  ComputedFields: never
                  Insert: {
                    "acronym"?: string | null,"archived_at"?: string | null,"color"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"email"?: string | null,"field_clock"?: NonNullable<Json>,"id": string,"name": string,"row_version"?: number,"scope_id": string,"updated_at"?: string,"workspace_ids"?: Json | null
                  }
                  Update: {
                    "acronym"?: string | null,"archived_at"?: string | null,"color"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"email"?: string | null,"field_clock"?: NonNullable<Json>,"id"?: string,"name"?: string,"row_version"?: number,"scope_id"?: string,"updated_at"?: string,"workspace_ids"?: Json | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "collaborators_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    }
                  ]
                },"devices": {
                  Row: {
                    "created_at": string,"created_by": string | null,"deleted_at": string | null,"field_clock": NonNullable<Json>,"id": string,"last_sync_at": string | null,"name": string,"platform": string,"push_subscription": Json | null,"reminder_channel": string,"row_version": number,"scope_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id": string,"last_sync_at"?: string | null,"name": string,"platform": string,"push_subscription"?: Json | null,"reminder_channel"?: string,"row_version"?: number,"scope_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id"?: string,"last_sync_at"?: string | null,"name"?: string,"platform"?: string,"push_subscription"?: Json | null,"reminder_channel"?: string,"row_version"?: number,"scope_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "devices_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    }
                  ]
                },"inbound_addresses": {
                  Row: {
                    "created_at": string,"list_id": string | null,"senders": (string)[],"time_zone": string,"token": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"list_id"?: string | null,"senders"?: (string)[],"time_zone"?: string,"token": string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"list_id"?: string | null,"senders"?: (string)[],"time_zone"?: string,"token"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "inbound_addresses_list_id_fkey"
      columns: ["list_id"]
isOneToOne: false
      referencedRelation: "lists"
      referencedColumns: ["id"]
    }
                  ]
                },"inbound_messages": {
                  Row: {
                    "from_addr": string | null,"id": string,"message_id": string | null,"reason": string | null,"received_at": string,"row_version": number,"status": string,"subject": string | null,"task_id": string | null,"to_addr": string | null,"updated_at": string,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "from_addr"?: string | null,"id"?: string,"message_id"?: string | null,"reason"?: string | null,"received_at"?: string,"row_version"?: number,"status": string,"subject"?: string | null,"task_id"?: string | null,"to_addr"?: string | null,"updated_at"?: string,"user_id"?: string | null
                  }
                  Update: {
                    "from_addr"?: string | null,"id"?: string,"message_id"?: string | null,"reason"?: string | null,"received_at"?: string,"row_version"?: number,"status"?: string,"subject"?: string | null,"task_id"?: string | null,"to_addr"?: string | null,"updated_at"?: string,"user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "inbound_messages_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"integration_tombstones": {
                  Row: {
                    "deleted_at": string,"id": string,"row_version": number,"tbl": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "deleted_at"?: string,"id": string,"row_version": number,"tbl": string,"user_id": string
                  }
                  Update: {
                    "deleted_at"?: string,"id"?: string,"row_version"?: number,"tbl"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"lists": {
                  Row: {
                    "archived_at": string | null,"board_columns": Json | null,"canvas_groups": Json | null,"color": string | null,"created_at": string,"created_by": string | null,"deleted_at": string | null,"description_md": string | null,"end_date": string | null,"field_clock": NonNullable<Json>,"guest_access": string,"icon": string | null,"id": string,"kind": string,"name": string,"project_status": string | null,"row_version": number,"scope_id": string,"sort_key": string,"start_date": string | null,"updated_at": string,"view_prefs": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"board_columns"?: Json | null,"canvas_groups"?: Json | null,"color"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"description_md"?: string | null,"end_date"?: string | null,"field_clock"?: NonNullable<Json>,"guest_access"?: string,"icon"?: string | null,"id": string,"kind"?: string,"name": string,"project_status"?: string | null,"row_version"?: number,"scope_id": string,"sort_key"?: string,"start_date"?: string | null,"updated_at"?: string,"view_prefs"?: NonNullable<Json>
                  }
                  Update: {
                    "archived_at"?: string | null,"board_columns"?: Json | null,"canvas_groups"?: Json | null,"color"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"description_md"?: string | null,"end_date"?: string | null,"field_clock"?: NonNullable<Json>,"guest_access"?: string,"icon"?: string | null,"id"?: string,"kind"?: string,"name"?: string,"project_status"?: string | null,"row_version"?: number,"scope_id"?: string,"sort_key"?: string,"start_date"?: string | null,"updated_at"?: string,"view_prefs"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "lists_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    }
                  ]
                },"notifications": {
                  Row: {
                    "actor_id": string | null,"at": string,"created_at": string,"created_by": string | null,"data": NonNullable<Json>,"deleted_at": string | null,"field_clock": NonNullable<Json>,"group_key": string | null,"id": string,"kind": string,"read_at": string | null,"row_version": number,"scope_id": string,"task_id": string | null,"updated_at": string,"user_id": string,"workspace_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id"?: string | null,"at"?: string,"created_at"?: string,"created_by"?: string | null,"data"?: NonNullable<Json>,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"group_key"?: string | null,"id": string,"kind": string,"read_at"?: string | null,"row_version"?: number,"scope_id": string,"task_id"?: string | null,"updated_at"?: string,"user_id": string,"workspace_id"?: string | null
                  }
                  Update: {
                    "actor_id"?: string | null,"at"?: string,"created_at"?: string,"created_by"?: string | null,"data"?: NonNullable<Json>,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"group_key"?: string | null,"id"?: string,"kind"?: string,"read_at"?: string | null,"row_version"?: number,"scope_id"?: string,"task_id"?: string | null,"updated_at"?: string,"user_id"?: string,"workspace_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "notifications_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    }
                  ]
                },"oauth_states": {
                  Row: {
                    "created_at": string,"provider": string,"redirect_to": string | null,"state": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"provider": string,"redirect_to"?: string | null,"state": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"provider"?: string,"redirect_to"?: string | null,"state"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"plugin_connections": {
                  Row: {
                    "config": NonNullable<Json>,"created_at": string,"deleted_at": string | null,"id": string,"label": string,"last_error": string | null,"last_used_at": string | null,"plugin": string,"row_version": number,"secret_id": string | null,"status": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "config"?: NonNullable<Json>,"created_at"?: string,"deleted_at"?: string | null,"id"?: string,"label": string,"last_error"?: string | null,"last_used_at"?: string | null,"plugin": string,"row_version"?: number,"secret_id"?: string | null,"status"?: string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "config"?: NonNullable<Json>,"created_at"?: string,"deleted_at"?: string | null,"id"?: string,"label"?: string,"last_error"?: string | null,"last_used_at"?: string | null,"plugin"?: string,"row_version"?: number,"secret_id"?: string | null,"status"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"plugin_deliveries": {
                  Row: {
                    "attempts": number,"connection_id": string | null,"context": Json | null,"created_at": string,"error": string | null,"events": (string)[],"external_id": string | null,"external_url": string | null,"http_status": number | null,"id": string,"next_attempt_at": string,"payload": Json | null,"rule_id": string | null,"sent_at": string | null,"source": string,"status": string,"task_id": string | null,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"connection_id"?: string | null,"context"?: Json | null,"created_at"?: string,"error"?: string | null,"events"?: (string)[],"external_id"?: string | null,"external_url"?: string | null,"http_status"?: number | null,"id": string,"next_attempt_at"?: string,"payload"?: Json | null,"rule_id"?: string | null,"sent_at"?: string | null,"source": string,"status"?: string,"task_id"?: string | null,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "attempts"?: number,"connection_id"?: string | null,"context"?: Json | null,"created_at"?: string,"error"?: string | null,"events"?: (string)[],"external_id"?: string | null,"external_url"?: string | null,"http_status"?: number | null,"id"?: string,"next_attempt_at"?: string,"payload"?: Json | null,"rule_id"?: string | null,"sent_at"?: string | null,"source"?: string,"status"?: string,"task_id"?: string | null,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"plugin_links": {
                  Row: {
                    "connection_id": string,"created_at": string,"external_id": string,"external_url": string | null,"task_id": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "connection_id": string,"created_at"?: string,"external_id": string,"external_url"?: string | null,"task_id": string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "connection_id"?: string,"created_at"?: string,"external_id"?: string,"external_url"?: string | null,"task_id"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "plugin_links_connection_id_fkey"
      columns: ["connection_id"]
isOneToOne: false
      referencedRelation: "plugin_connections"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "plugin_links_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"plugin_outbox": {
                  Row: {
                    "after": Json | null,"before": Json | null,"created_at": string,"extra": Json | null,"id": number,"origin": string,"processed_at": string | null,"row_id": string,"scope_id": string,"table_name": string,"task_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "after"?: Json | null,"before"?: Json | null,"created_at"?: string,"extra"?: Json | null,"id"?: never,"origin"?: string,"processed_at"?: string | null,"row_id": string,"scope_id": string,"table_name": string,"task_id"?: string | null
                  }
                  Update: {
                    "after"?: Json | null,"before"?: Json | null,"created_at"?: string,"extra"?: Json | null,"id"?: never,"origin"?: string,"processed_at"?: string | null,"row_id"?: string,"scope_id"?: string,"table_name"?: string,"task_id"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"plugin_requests": {
                  Row: {
                    "created_at": string,"created_by": string | null,"deleted_at": string | null,"field_clock": NonNullable<Json>,"id": string,"requested_at": string,"row_version": number,"rule_id": string,"scope_id": string,"task_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id": string,"requested_at": string,"row_version"?: number,"rule_id": string,"scope_id": string,"task_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id"?: string,"requested_at"?: string,"row_version"?: number,"rule_id"?: string,"scope_id"?: string,"task_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "plugin_requests_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    }
                  ]
                },"plugin_rules": {
                  Row: {
                    "action": NonNullable<Json>,"connection_id": string,"created_at": string,"created_by": string | null,"deleted_at": string | null,"enabled": boolean,"field_clock": NonNullable<Json>,"id": string,"name": string,"options": NonNullable<Json>,"row_version": number,"scope_id": string,"sort_key": string,"trigger": NonNullable<Json>,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action": NonNullable<Json>,"connection_id": string,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"enabled": boolean,"field_clock"?: NonNullable<Json>,"id": string,"name": string,"options": NonNullable<Json>,"row_version"?: number,"scope_id": string,"sort_key": string,"trigger": NonNullable<Json>,"updated_at"?: string
                  }
                  Update: {
                    "action"?: NonNullable<Json>,"connection_id"?: string,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"enabled"?: boolean,"field_clock"?: NonNullable<Json>,"id"?: string,"name"?: string,"options"?: NonNullable<Json>,"row_version"?: number,"scope_id"?: string,"sort_key"?: string,"trigger"?: NonNullable<Json>,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "plugin_rules_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    }
                  ]
                },"plugin_runs": {
                  Row: {
                    "expires_at": string | null,"holder": string | null,"name": string,"rerun": boolean
                  }
                  ComputedFields: never
                  Insert: {
                    "expires_at"?: string | null,"holder"?: string | null,"name": string,"rerun"?: boolean
                  }
                  Update: {
                    "expires_at"?: string | null,"holder"?: string | null,"name"?: string,"rerun"?: boolean
                  }
                  Relationships: [
                    
                  ]
                },"profiles": {
                  Row: {
                    "calendar_sync": Json | null,"created_at": string,"created_by": string | null,"deleted_at": string | null,"display_name": string | null,"field_clock": NonNullable<Json>,"focus": Json | null,"id": string,"row_version": number,"scope_id": string,"settings": NonNullable<Json>,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "calendar_sync"?: Json | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"display_name"?: string | null,"field_clock"?: NonNullable<Json>,"focus"?: Json | null,"id": string,"row_version"?: number,"scope_id": string,"settings"?: NonNullable<Json>,"updated_at"?: string
                  }
                  Update: {
                    "calendar_sync"?: Json | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"display_name"?: string | null,"field_clock"?: NonNullable<Json>,"focus"?: Json | null,"id"?: string,"row_version"?: number,"scope_id"?: string,"settings"?: NonNullable<Json>,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "profiles_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    }
                  ]
                },"project_templates": {
                  Row: {
                    "content": NonNullable<Json>,"created_at": string,"created_by": string | null,"deleted_at": string | null,"field_clock": NonNullable<Json>,"id": string,"name": string,"row_version": number,"scope_id": string,"sort_key": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "content": NonNullable<Json>,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id": string,"name": string,"row_version"?: number,"scope_id": string,"sort_key": string,"updated_at"?: string
                  }
                  Update: {
                    "content"?: NonNullable<Json>,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id"?: string,"name"?: string,"row_version"?: number,"scope_id"?: string,"sort_key"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "project_templates_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    }
                  ]
                },"purged_files": {
                  Row: {
                    "path": string,"purged_at": string,"purged_by": string
                  }
                  ComputedFields: never
                  Insert: {
                    "path": string,"purged_at"?: string,"purged_by": string
                  }
                  Update: {
                    "path"?: string,"purged_at"?: string,"purged_by"?: string
                  }
                  Relationships: [
                    
                  ]
                },"purged_tasks": {
                  Row: {
                    "id": string,"purged_at": string,"purged_by": string | null,"row_version": number,"scope_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "id": string,"purged_at"?: string,"purged_by"?: string | null,"row_version": number,"scope_id": string
                  }
                  Update: {
                    "id"?: string,"purged_at"?: string,"purged_by"?: string | null,"row_version"?: number,"scope_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "purged_tasks_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    }
                  ]
                },"reminder_deliveries": {
                  Row: {
                    "attempts": number,"claimed_at": string,"device_id": string,"error": string | null,"fire_at": string,"fire_key": string,"id": number,"sent_at": string | null,"status": string,"task_id": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"claimed_at"?: string,"device_id": string,"error"?: string | null,"fire_at": string,"fire_key": string,"id"?: never,"sent_at"?: string | null,"status"?: string,"task_id"?: string | null,"user_id": string
                  }
                  Update: {
                    "attempts"?: number,"claimed_at"?: string,"device_id"?: string,"error"?: string | null,"fire_at"?: string,"fire_key"?: string,"id"?: never,"sent_at"?: string | null,"status"?: string,"task_id"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "reminder_deliveries_device_id_fkey"
      columns: ["device_id"]
isOneToOne: false
      referencedRelation: "devices"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reminder_deliveries_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"reminders": {
                  Row: {
                    "at_date": string | null,"at_time": string | null,"created_at": string,"created_by": string | null,"deleted_at": string | null,"field_clock": NonNullable<Json>,"id": string,"kind": string,"offset_min": number | null,"row_version": number,"scope_id": string,"task_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "at_date"?: string | null,"at_time"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id": string,"kind": string,"offset_min"?: number | null,"row_version"?: number,"scope_id": string,"task_id": string,"updated_at"?: string
                  }
                  Update: {
                    "at_date"?: string | null,"at_time"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id"?: string,"kind"?: string,"offset_min"?: number | null,"row_version"?: number,"scope_id"?: string,"task_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "reminders_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reminders_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"review_sessions": {
                  Row: {
                    "created_at": string,"created_by": string | null,"deleted_at": string | null,"field_clock": NonNullable<Json>,"finished_at": string | null,"id": string,"kind": string,"row_version": number,"scope_id": string,"started_at": string,"stats": Json | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"finished_at"?: string | null,"id": string,"kind": string,"row_version"?: number,"scope_id": string,"started_at": string,"stats"?: Json | null,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"finished_at"?: string | null,"id"?: string,"kind"?: string,"row_version"?: number,"scope_id"?: string,"started_at"?: string,"stats"?: Json | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "review_sessions_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    }
                  ]
                },"saved_filters": {
                  Row: {
                    "created_at": string,"created_by": string | null,"deleted_at": string | null,"field_clock": NonNullable<Json>,"icon": string | null,"id": string,"name": string,"query": NonNullable<Json>,"row_version": number,"scope_id": string,"sort_key": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"icon"?: string | null,"id": string,"name": string,"query"?: NonNullable<Json>,"row_version"?: number,"scope_id": string,"sort_key"?: string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"icon"?: string | null,"id"?: string,"name"?: string,"query"?: NonNullable<Json>,"row_version"?: number,"scope_id"?: string,"sort_key"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "saved_filters_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    }
                  ]
                },"scope_collaborators": {
                  Row: {
                    "acronym": string | null,"archived_at": string | null,"collaborator_id": string,"color": string | null,"created_at": string,"deleted_at": string | null,"id": string,"name": string,"row_version": number,"scope_id": string,"updated_at": string,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "acronym"?: string | null,"archived_at"?: string | null,"collaborator_id": string,"color"?: string | null,"created_at"?: string,"deleted_at"?: string | null,"id": string,"name": string,"row_version"?: number,"scope_id": string,"updated_at"?: string,"user_id"?: string | null
                  }
                  Update: {
                    "acronym"?: string | null,"archived_at"?: string | null,"collaborator_id"?: string,"color"?: string | null,"created_at"?: string,"deleted_at"?: string | null,"id"?: string,"name"?: string,"row_version"?: number,"scope_id"?: string,"updated_at"?: string,"user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "scope_collaborators_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    }
                  ]
                },"scope_invites": {
                  Row: {
                    "created_at": string,"email": string,"expires_at": string,"id": string,"invited_by": string,"role": string,"scope_id": string,"token": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"email": string,"expires_at"?: string,"id"?: string,"invited_by": string,"role": string,"scope_id": string,"token"?: string
                  }
                  Update: {
                    "created_at"?: string,"email"?: string,"expires_at"?: string,"id"?: string,"invited_by"?: string,"role"?: string,"scope_id"?: string,"token"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "scope_invites_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    }
                  ]
                },"scope_members": {
                  Row: {
                    "joined_at": string | null,"role": string,"scope_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "joined_at"?: string | null,"role"?: string,"scope_id": string,"user_id": string
                  }
                  Update: {
                    "joined_at"?: string | null,"role"?: string,"scope_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "scope_members_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    }
                  ]
                },"scope_owner_offers": {
                  Row: {
                    "after_role": string | null,"created_at": string,"expires_at": string,"id": string,"offered_by": string,"scope_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "after_role"?: string | null,"created_at"?: string,"expires_at"?: string,"id"?: string,"offered_by": string,"scope_id": string,"user_id": string
                  }
                  Update: {
                    "after_role"?: string | null,"created_at"?: string,"expires_at"?: string,"id"?: string,"offered_by"?: string,"scope_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "scope_owner_offers_scope_id_offered_by_fkey"
      columns: ["scope_id","offered_by"]
isOneToOne: false
      referencedRelation: "scope_members"
      referencedColumns: ["scope_id","user_id"]
    },{
      foreignKeyName: "scope_owner_offers_scope_id_user_id_fkey"
      columns: ["scope_id","user_id"]
isOneToOne: false
      referencedRelation: "scope_members"
      referencedColumns: ["scope_id","user_id"]
    }
                  ]
                },"scope_tags": {
                  Row: {
                    "color": string | null,"created_at": string,"deleted_at": string | null,"id": string,"name": string,"row_version": number,"scope_id": string,"tag_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "color"?: string | null,"created_at"?: string,"deleted_at"?: string | null,"id": string,"name": string,"row_version"?: number,"scope_id": string,"tag_id": string,"updated_at"?: string
                  }
                  Update: {
                    "color"?: string | null,"created_at"?: string,"deleted_at"?: string | null,"id"?: string,"name"?: string,"row_version"?: number,"scope_id"?: string,"tag_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "scope_tags_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    }
                  ]
                },"sync_scopes": {
                  Row: {
                    "created_at": string,"id": string,"kind": string,"owner_id": string,"sync_version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id": string,"kind": string,"owner_id": string,"sync_version"?: number
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"kind"?: string,"owner_id"?: string,"sync_version"?: number
                  }
                  Relationships: [
                    
                  ]
                },"tags": {
                  Row: {
                    "color": string | null,"created_at": string,"created_by": string | null,"deleted_at": string | null,"field_clock": NonNullable<Json>,"id": string,"name": string,"row_version": number,"scope_id": string,"sort_key": string,"updated_at": string,"workspace_ids": Json | null
                  }
                  ComputedFields: never
                  Insert: {
                    "color"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id": string,"name": string,"row_version"?: number,"scope_id": string,"sort_key"?: string,"updated_at"?: string,"workspace_ids"?: Json | null
                  }
                  Update: {
                    "color"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id"?: string,"name"?: string,"row_version"?: number,"scope_id"?: string,"sort_key"?: string,"updated_at"?: string,"workspace_ids"?: Json | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "tags_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    }
                  ]
                },"task_comments": {
                  Row: {
                    "body": string,"created_at": string,"created_by": string | null,"deleted_at": string | null,"edited_at": string | null,"field_clock": NonNullable<Json>,"id": string,"posted_at": string,"row_version": number,"scope_id": string,"task_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "body": string,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"edited_at"?: string | null,"field_clock"?: NonNullable<Json>,"id": string,"posted_at": string,"row_version"?: number,"scope_id": string,"task_id": string,"updated_at"?: string
                  }
                  Update: {
                    "body"?: string,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"edited_at"?: string | null,"field_clock"?: NonNullable<Json>,"id"?: string,"posted_at"?: string,"row_version"?: number,"scope_id"?: string,"task_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "task_comments_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "task_comments_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"task_completions": {
                  Row: {
                    "completed_at": string,"created_at": string,"created_by": string | null,"deleted_at": string | null,"field_clock": NonNullable<Json>,"id": string,"kind": string,"occurrence_date": string,"row_version": number,"scope_id": string,"task_id": string,"updated_at": string,"value": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "completed_at"?: string,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id": string,"kind"?: string,"occurrence_date": string,"row_version"?: number,"scope_id": string,"task_id": string,"updated_at"?: string,"value"?: number | null
                  }
                  Update: {
                    "completed_at"?: string,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id"?: string,"kind"?: string,"occurrence_date"?: string,"row_version"?: number,"scope_id"?: string,"task_id"?: string,"updated_at"?: string,"value"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "task_completions_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "task_completions_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"task_dependencies": {
                  Row: {
                    "created_at": string,"created_by": string | null,"deleted_at": string | null,"field_clock": NonNullable<Json>,"id": string,"kind": string,"lag_days": number,"predecessor_id": string,"row_version": number,"scope_id": string,"successor_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id": string,"kind"?: string,"lag_days"?: number,"predecessor_id": string,"row_version"?: number,"scope_id": string,"successor_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id"?: string,"kind"?: string,"lag_days"?: number,"predecessor_id"?: string,"row_version"?: number,"scope_id"?: string,"successor_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "task_dependencies_predecessor_id_fkey"
      columns: ["predecessor_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "task_dependencies_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "task_dependencies_successor_id_fkey"
      columns: ["successor_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"task_participants": {
                  Row: {
                    "collaborator_id": string,"created_at": string,"created_by": string | null,"deleted_at": string | null,"field_clock": NonNullable<Json>,"id": string,"row_version": number,"scope_id": string,"task_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "collaborator_id": string,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id": string,"row_version"?: number,"scope_id": string,"task_id": string,"updated_at"?: string
                  }
                  Update: {
                    "collaborator_id"?: string,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id"?: string,"row_version"?: number,"scope_id"?: string,"task_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "task_participants_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "task_participants_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"task_tags": {
                  Row: {
                    "created_at": string,"created_by": string | null,"deleted_at": string | null,"field_clock": NonNullable<Json>,"id": string,"row_version": number,"scope_id": string,"sort_key": string | null,"tag_id": string,"task_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id": string,"row_version"?: number,"scope_id": string,"sort_key"?: string | null,"tag_id": string,"task_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id"?: string,"row_version"?: number,"scope_id"?: string,"sort_key"?: string | null,"tag_id"?: string,"task_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "task_tags_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "task_tags_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"tasks": {
                  Row: {
                    "assignee_id": string | null,"board_column_id": string | null,"board_sort_key": string | null,"canvas_pos": Json | null,"completed_at": string | null,"created_at": string,"created_by": string | null,"deleted_at": string | null,"derived_from": Json | null,"description_md": string | null,"due_date": string | null,"due_time": string | null,"duration_min": number | null,"field_clock": NonNullable<Json>,"habit": Json | null,"id": string,"kind": string,"list_id": string,"parent_id": string | null,"postpone_count": number,"priority": number,"recurrence": Json | null,"row_version": number,"scope_id": string,"sort_key": string,"source": Json | null,"start_date": string | null,"status": string,"time_zone": string | null,"title": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "assignee_id"?: string | null,"board_column_id"?: string | null,"board_sort_key"?: string | null,"canvas_pos"?: Json | null,"completed_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"derived_from"?: Json | null,"description_md"?: string | null,"due_date"?: string | null,"due_time"?: string | null,"duration_min"?: number | null,"field_clock"?: NonNullable<Json>,"habit"?: Json | null,"id": string,"kind"?: string,"list_id": string,"parent_id"?: string | null,"postpone_count"?: number,"priority"?: number,"recurrence"?: Json | null,"row_version"?: number,"scope_id": string,"sort_key"?: string,"source"?: Json | null,"start_date"?: string | null,"status"?: string,"time_zone"?: string | null,"title": string,"updated_at"?: string
                  }
                  Update: {
                    "assignee_id"?: string | null,"board_column_id"?: string | null,"board_sort_key"?: string | null,"canvas_pos"?: Json | null,"completed_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"derived_from"?: Json | null,"description_md"?: string | null,"due_date"?: string | null,"due_time"?: string | null,"duration_min"?: number | null,"field_clock"?: NonNullable<Json>,"habit"?: Json | null,"id"?: string,"kind"?: string,"list_id"?: string,"parent_id"?: string | null,"postpone_count"?: number,"priority"?: number,"recurrence"?: Json | null,"row_version"?: number,"scope_id"?: string,"sort_key"?: string,"source"?: Json | null,"start_date"?: string | null,"status"?: string,"time_zone"?: string | null,"title"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tasks_list_id_fkey"
      columns: ["list_id"]
isOneToOne: false
      referencedRelation: "lists"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tasks_parent_id_fkey"
      columns: ["parent_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tasks_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    }
                  ]
                },"time_entries": {
                  Row: {
                    "created_at": string,"created_by": string | null,"deleted_at": string | null,"ended_at": string | null,"field_clock": NonNullable<Json>,"id": string,"kind": string,"pomodoro_index": number | null,"row_version": number,"scope_id": string,"started_at": string,"task_id": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"ended_at"?: string | null,"field_clock"?: NonNullable<Json>,"id": string,"kind": string,"pomodoro_index"?: number | null,"row_version"?: number,"scope_id": string,"started_at": string,"task_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"ended_at"?: string | null,"field_clock"?: NonNullable<Json>,"id"?: string,"kind"?: string,"pomodoro_index"?: number | null,"row_version"?: number,"scope_id"?: string,"started_at"?: string,"task_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "time_entries_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "time_entries_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"workspaces": {
                  Row: {
                    "archived_at": string | null,"board_columns": Json | null,"color": string | null,"created_at": string,"created_by": string | null,"deleted_at": string | null,"field_clock": NonNullable<Json>,"icon": string | null,"id": string,"name": string,"row_version": number,"scope_id": string,"sort_key": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"board_columns"?: Json | null,"color"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"icon"?: string | null,"id": string,"name": string,"row_version"?: number,"scope_id": string,"sort_key"?: string,"updated_at"?: string
                  }
                  Update: {
                    "archived_at"?: string | null,"board_columns"?: Json | null,"color"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"icon"?: string | null,"id"?: string,"name"?: string,"row_version"?: number,"scope_id"?: string,"sort_key"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "workspaces_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "accept_scope_invite":
{ Args: { "p_id"?: string,"p_token"?: string }; Returns: string
                           },
"account_secret_get":
{ Args: { "p_account": string }; Returns: string
                           },
"account_secret_set":
{ Args: { "p_account": string,"p_secret": string }; Returns: undefined
                           },
"activity_actor":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"activity_source":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"add_invite":
{ Args: { "p_note"?: string,"p_pattern": string }; Returns: undefined
                           },
"ai_account_remove":
{ Args: { "p_account": string }; Returns: undefined
                           },
"ai_secret_get":
{ Args: { "p_account": string }; Returns: string
                           },
"ai_secret_set":
{ Args: { "p_account": string,"p_secret": string }; Returns: undefined
                           },
"answer_workspace_ownership_offer":
{ Args: { "p_accept": boolean,"p_id": string }; Returns: string
                           },
"assignee_reminder_tasks":
{ Args: { "p_from": string,"p_to": string,"p_users": (string)[] }; Returns: {
              "due_date": string,"due_time": string,"id": string,"kind": string,"recurrence": Json,"status": string,"time_zone": string,"title": string,"user_id": string
            }[]
                           },
"attachment_quota_bytes":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"attachment_usage":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"calendar_kick":
{ Args: { "p_user": string }; Returns: undefined
                           },
"calendar_sync_disable":
{ Args: { "p_account": string,"p_user": string }; Returns: undefined
                           },
"calendar_task_apply":
{ Args: { "p_calendar": string,"p_link": Json,"p_patch": Json,"p_task": string }; Returns: Json
                           },
"calendar_task_create":
{ Args: { "p_calendar": string,"p_link": Json,"p_task": Json }; Returns: string
                           },
"calendar_task_lock":
{ Args: { "p_calendar": string,"p_holder": string,"p_ttl_seconds"?: number }; Returns: boolean
                           },
"calendar_task_unlock":
{ Args: { "p_calendar": string,"p_holder": string,"p_ttl_seconds"?: number }; Returns: boolean
                           },
"call_edge_function":
{ Args: { "p_body"?: Json,"p_path": string }; Returns: number
                           },
"caller_email":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"can_purge_file":
{ Args: { "p_name": string }; Returns: boolean
                           },
"can_read_attachment":
{ Args: { "p_name": string }; Returns: boolean
                           },
"can_set_own_reminder":
{ Args: { "p_removing"?: boolean,"p_task": string }; Returns: boolean
                           },
"can_upload_attachment":
{ Args: { "p_name": string }; Returns: boolean
                           },
"can_use_collaborator":
{ Args: { "p_collaborator": string,"p_scope": string }; Returns: boolean
                           },
"can_use_tag":
{ Args: { "p_scope": string,"p_tag": string }; Returns: boolean
                           },
"can_write_scope":
{ Args: { "p_scope": string }; Returns: boolean
                           },
"cancel_workspace_ownership_offer":
{ Args: { "p_id": string }; Returns: boolean
                           },
"claim_plugin_deliveries":
{ Args: { "p_limit"?: number,"p_per_minute"?: number }; Returns: {
              "attempts": number,
"connection_id": string | null,
"context": Json | null,
"created_at": string,
"error": string | null,
"events": (string)[],
"external_id": string | null,
"external_url": string | null,
"http_status": number | null,
"id": string,
"next_attempt_at": string,
"payload": Json | null,
"rule_id": string | null,
"sent_at": string | null,
"source": string,
"status": string,
"task_id": string | null,
"updated_at": string,
"user_id": string
            }[]
                          SetofOptions: {
        from: "*"
        to: "plugin_deliveries"
        isOneToOne: false
        isSetofReturn: true
      } },
"claim_reminder_deliveries":
{ Args: { "p_items": Json }; Returns: {
              "attempts": number,
"claimed_at": string,
"device_id": string,
"error": string | null,
"fire_at": string,
"fire_key": string,
"id": number,
"sent_at": string | null,
"status": string,
"task_id": string | null,
"user_id": string
            }[]
                          SetofOptions: {
        from: "*"
        to: "reminder_deliveries"
        isOneToOne: false
        isSetofReturn: true
      } },
"clear_push_subscription":
{ Args: { "p_device": string,"p_endpoint": string }; Returns: undefined
                           },
"collaborator_account":
{ Args: { "p_collaborator": string,"p_scope": string }; Returns: string
                           },
"collaborator_used_in":
{ Args: { "p_collaborator": string,"p_scope": string }; Returns: boolean
                           },
"create_integration_task":
{ Args: { "p_tags"?: Json,"p_task": Json,"p_user": string }; Returns: string
                           },
"decline_scope_invite":
{ Args: { "p_id": string }; Returns: boolean
                           },
"drop_scope_owner":
{ Args: { "p_after": string,"p_scope": string,"p_user": string }; Returns: undefined
                           },
"has_scope_access":
{ Args: { "p_scope": string }; Returns: boolean
                           },
"hidden_lists":
{ Args: { "p_user"?: string }; Returns: (string)[]
                           },
"hook_before_user_created":
{ Args: { "event": Json }; Returns: Json
                           },
"inbound_context":
{ Args: { "p_user": string }; Returns: Json
                           },
"is_app_admin":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"is_primary_owner":
{ Args: { "p_scope": string }; Returns: boolean
                           },
"list_access":
{ Args: { "p_list": string,"p_user"?: string }; Returns: string
                           },
"list_invites":
{ Args: Record<PropertyKey, never>; Returns: {
              "accounts": number,"created_at": string,"note": string,"pattern": string
            }[]
                           },
"list_visible":
{ Args: { "p_list": string }; Returns: boolean
                           },
"lock_workspace_owner":
{ Args: { "p_scope": string }; Returns: undefined
                           },
"mark_notification_read":
{ Args: { "p_id": string }; Returns: boolean
                           },
"mirror_collaborator":
{ Args: { "p_collaborator": string,"p_scope": string }; Returns: undefined
                           },
"mirror_tag":
{ Args: { "p_scope": string,"p_tag": string }; Returns: undefined
                           },
"my_ownership_offers":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"my_scope_invites":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"notification_actor":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"notification_actor_name":
{ Args: { "p_actor": string,"p_user": string }; Returns: string
                           },
"notify":
{ Args: { "p_actor": string,"p_data": Json,"p_group"?: string,"p_kind": string,"p_task"?: string,"p_user": string,"p_workspace"?: string }; Returns: undefined
                           },
"notify_task":
{ Args: { "p_actor": string,"p_data"?: Json,"p_group"?: string,"p_kind": string,"p_task": Omit<Database["public"]['Tables']["tasks"]['Row'], Database["public"]['Tables']["tasks"]['ComputedFields']>,"p_user": string }; Returns: undefined
                           },
"offer_workspace_ownership":
{ Args: { "p_after"?: string,"p_scope": string,"p_user": string }; Returns: string
                           },
"plugin_after_send":
{ Args: { "p_add": Json,"p_remove": (string)[],"p_rule"?: string,"p_status": string,"p_task": string,"p_user": string }; Returns: string
                           },
"plugin_connection_remove":
{ Args: { "p_connection": string }; Returns: undefined
                           },
"plugin_event_rules":
{ Args: { "p_task": string }; Returns: {
              "action": NonNullable<Json>,
"connection_id": string,
"created_at": string,
"created_by": string | null,
"deleted_at": string | null,
"enabled": boolean,
"field_clock": NonNullable<Json>,
"id": string,
"name": string,
"options": NonNullable<Json>,
"row_version": number,
"scope_id": string,
"sort_key": string,
"trigger": NonNullable<Json>,
"updated_at": string
            }[]
                          SetofOptions: {
        from: "*"
        to: "plugin_rules"
        isOneToOne: false
        isSetofReturn: true
      } },
"plugin_events_wanted":
{ Args: { "p_scope": string }; Returns: boolean
                           },
"plugin_kick":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"plugin_lock":
{ Args: { "p_holder": string,"p_name": string,"p_ttl_seconds"?: number }; Returns: boolean
                           },
"plugin_origin":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"plugin_secret_get":
{ Args: { "p_connection": string }; Returns: string
                           },
"plugin_secret_set":
{ Args: { "p_connection": string,"p_secret": string }; Returns: undefined
                           },
"plugin_task_context":
{ Args: { "p_task": string,"p_user": string }; Returns: Json
                           },
"plugin_task_extra":
{ Args: { "p_extra": Json,"p_row": string,"p_table": string,"p_task": string }; Returns: undefined
                           },
"plugin_task_state":
{ Args: { "p_tags": (string)[],"p_task": Omit<Database["public"]['Tables']["tasks"]['Row'], Database["public"]['Tables']["tasks"]['ComputedFields']> }; Returns: Json
                           },
"plugin_task_state_now":
{ Args: { "p_task": string }; Returns: Json
                           },
"plugin_task_tag_ids":
{ Args: { "p_task": string }; Returns: (string)[]
                           },
"plugin_unlock":
{ Args: { "p_holder": string,"p_name": string,"p_ttl_seconds"?: number }; Returns: boolean
                           },
"plugins_tick":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"pull_changes":
{ Args: { "p_limit"?: number,"p_since"?: Json }; Returns: Json
                           },
"pulled_readonly_tables":
{ Args: Record<PropertyKey, never>; Returns: (string)[]
                           },
"purge_tasks":
{ Args: { "p_ids": (string)[] }; Returns: Json
                           },
"push_changes":
{ Args: { "p_ops": Json }; Returns: Json
                           },
"random_token":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"refresh_scope_accounts":
{ Args: { "p_scope": string }; Returns: undefined
                           },
"remove_invite":
{ Args: { "p_pattern": string }; Returns: boolean
                           },
"remove_scope_member":
{ Args: { "p_scope": string,"p_user": string }; Returns: undefined
                           },
"report_client_errors":
{ Args: { "p_items": Json }; Returns: number
                           },
"require_app_admin":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"require_workspace_owner":
{ Args: { "p_scope": string }; Returns: undefined
                           },
"resign_workspace_owner":
{ Args: { "p_after"?: string,"p_scope": string }; Returns: undefined
                           },
"retry_plugin_delivery":
{ Args: { "p_delivery": string }; Returns: undefined
                           },
"revoke_scope_invite":
{ Args: { "p_id": string }; Returns: boolean
                           },
"rotate_inbound_token":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"row_lists":
{ Args: { "p_row": Json,"p_table": string }; Returns: (string)[]
                           },
"row_visible":
{ Args: { "p_row": Json,"p_table": string }; Returns: boolean
                           },
"scope_has_others":
{ Args: { "p_actor": string,"p_scope": string }; Returns: boolean
                           },
"scope_role":
{ Args: { "p_scope": string }; Returns: string
                           },
"server_hlc":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"set_inbound_senders":
{ Args: { "p_senders": (string)[] }; Returns: undefined
                           },
"set_scope_member_role":
{ Args: { "p_role": string,"p_scope": string,"p_user": string }; Returns: undefined
                           },
"share_workspace":
{ Args: { "p_email": string,"p_role": string,"p_scope": string }; Returns: Json
                           },
"signal_scope":
{ Args: { "p_scope": string }; Returns: undefined
                           },
"sync_collaborator_spaces":
{ Args: { "p_collaborator": string }; Returns: undefined
                           },
"sync_tag_spaces":
{ Args: { "p_tag": string }; Returns: undefined
                           },
"synced_tables":
{ Args: Record<PropertyKey, never>; Returns: (string)[]
                           },
"tag_used_in":
{ Args: { "p_scope": string,"p_tag": string }; Returns: boolean
                           },
"task_responsible_account":
{ Args: { "p_assignee": string,"p_creator": string,"p_scope": string }; Returns: string
                           },
"task_visible":
{ Args: { "p_task": string }; Returns: boolean
                           },
"workspace_name":
{ Args: { "p_scope": string }; Returns: string
                           },
"workspace_sharing":
{ Args: { "p_scope": string }; Returns: Json
                           },
"writable_columns":
{ Args: { "p_table": string }; Returns: (string)[]
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            
          }
        }
} as const
