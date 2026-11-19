
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "activity_log": {
                  Row: {
                    "actor_id": string | null,"at": string,"changes": NonNullable<Json>,"device_id": string | null,"id": number,"row_id": string,"scope_id": string,"table_name": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id"?: string | null,"at"?: string,"changes": NonNullable<Json>,"device_id"?: string | null,"id"?: never,"row_id": string,"scope_id": string,"table_name": string
                  }
                  Update: {
                    "actor_id"?: string | null,"at"?: string,"changes"?: NonNullable<Json>,"device_id"?: string | null,"id"?: never,"row_id"?: string,"scope_id"?: string,"table_name"?: string
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
                },"lists": {
                  Row: {
                    "archived_at": string | null,"color": string | null,"created_at": string,"created_by": string | null,"deleted_at": string | null,"description_md": string | null,"end_date": string | null,"field_clock": NonNullable<Json>,"icon": string | null,"id": string,"kind": string,"name": string,"project_status": string | null,"row_version": number,"scope_id": string,"sort_key": string,"start_date": string | null,"updated_at": string,"view_prefs": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"color"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"description_md"?: string | null,"end_date"?: string | null,"field_clock"?: NonNullable<Json>,"icon"?: string | null,"id": string,"kind"?: string,"name": string,"project_status"?: string | null,"row_version"?: number,"scope_id": string,"sort_key"?: string,"start_date"?: string | null,"updated_at"?: string,"view_prefs"?: NonNullable<Json>
                  }
                  Update: {
                    "archived_at"?: string | null,"color"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"description_md"?: string | null,"end_date"?: string | null,"field_clock"?: NonNullable<Json>,"icon"?: string | null,"id"?: string,"kind"?: string,"name"?: string,"project_status"?: string | null,"row_version"?: number,"scope_id"?: string,"sort_key"?: string,"start_date"?: string | null,"updated_at"?: string,"view_prefs"?: NonNullable<Json>
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
                },"profiles": {
                  Row: {
                    "created_at": string,"created_by": string | null,"deleted_at": string | null,"display_name": string | null,"field_clock": NonNullable<Json>,"id": string,"row_version": number,"scope_id": string,"settings": NonNullable<Json>,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"display_name"?: string | null,"field_clock"?: NonNullable<Json>,"id": string,"row_version"?: number,"scope_id": string,"settings"?: NonNullable<Json>,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"display_name"?: string | null,"field_clock"?: NonNullable<Json>,"id"?: string,"row_version"?: number,"scope_id"?: string,"settings"?: NonNullable<Json>,"updated_at"?: string
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
                },"push_queue": {
                  Row: {
                    "attempts": number,"body": string | null,"claimed_at": string | null,"created_at": string,"delivered": number | null,"error": string | null,"id": string,"send_at": string,"sent_at": string | null,"task_id": string | null,"title": string,"url": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"body"?: string | null,"claimed_at"?: string | null,"created_at"?: string,"delivered"?: number | null,"error"?: string | null,"id"?: string,"send_at"?: string,"sent_at"?: string | null,"task_id"?: string | null,"title": string,"url"?: string | null,"user_id": string
                  }
                  Update: {
                    "attempts"?: number,"body"?: string | null,"claimed_at"?: string | null,"created_at"?: string,"delivered"?: number | null,"error"?: string | null,"id"?: string,"send_at"?: string,"sent_at"?: string | null,"task_id"?: string | null,"title"?: string,"url"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "push_queue_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"push_subscriptions": {
                  Row: {
                    "auth": string,"created_at": string,"endpoint": string,"failures": number,"id": string,"last_success_at": string | null,"p256dh": string,"user_agent": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "auth": string,"created_at"?: string,"endpoint": string,"failures"?: number,"id"?: string,"last_success_at"?: string | null,"p256dh": string,"user_agent"?: string | null,"user_id": string
                  }
                  Update: {
                    "auth"?: string,"created_at"?: string,"endpoint"?: string,"failures"?: number,"id"?: string,"last_success_at"?: string | null,"p256dh"?: string,"user_agent"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    
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
                },"scope_members": {
                  Row: {
                    "role": string,"scope_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "role"?: string,"scope_id": string,"user_id": string
                  }
                  Update: {
                    "role"?: string,"scope_id"?: string,"user_id"?: string
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
                    "color": string | null,"created_at": string,"created_by": string | null,"deleted_at": string | null,"field_clock": NonNullable<Json>,"id": string,"name": string,"row_version": number,"scope_id": string,"sort_key": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "color"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id": string,"name": string,"row_version"?: number,"scope_id": string,"sort_key"?: string,"updated_at"?: string
                  }
                  Update: {
                    "color"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id"?: string,"name"?: string,"row_version"?: number,"scope_id"?: string,"sort_key"?: string,"updated_at"?: string
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
                },"task_tags": {
                  Row: {
                    "created_at": string,"created_by": string | null,"deleted_at": string | null,"field_clock": NonNullable<Json>,"id": string,"row_version": number,"scope_id": string,"tag_id": string,"task_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id": string,"row_version"?: number,"scope_id": string,"tag_id": string,"task_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"id"?: string,"row_version"?: number,"scope_id"?: string,"tag_id"?: string,"task_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "task_tags_scope_id_fkey"
      columns: ["scope_id"]
isOneToOne: false
      referencedRelation: "sync_scopes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "task_tags_tag_id_fkey"
      columns: ["tag_id"]
isOneToOne: false
      referencedRelation: "tags"
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
                    "board_sort_key": string | null,"completed_at": string | null,"created_at": string,"created_by": string | null,"deleted_at": string | null,"description_md": string | null,"due_date": string | null,"due_time": string | null,"duration_min": number | null,"field_clock": NonNullable<Json>,"habit": Json | null,"id": string,"kind": string,"list_id": string,"parent_id": string | null,"postpone_count": number,"priority": number,"recurrence": Json | null,"row_version": number,"scope_id": string,"sort_key": string,"source": Json | null,"start_date": string | null,"status": string,"time_zone": string | null,"title": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "board_sort_key"?: string | null,"completed_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"description_md"?: string | null,"due_date"?: string | null,"due_time"?: string | null,"duration_min"?: number | null,"field_clock"?: NonNullable<Json>,"habit"?: Json | null,"id": string,"kind"?: string,"list_id": string,"parent_id"?: string | null,"postpone_count"?: number,"priority"?: number,"recurrence"?: Json | null,"row_version"?: number,"scope_id": string,"sort_key"?: string,"source"?: Json | null,"start_date"?: string | null,"status"?: string,"time_zone"?: string | null,"title": string,"updated_at"?: string
                  }
                  Update: {
                    "board_sort_key"?: string | null,"completed_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"description_md"?: string | null,"due_date"?: string | null,"due_time"?: string | null,"duration_min"?: number | null,"field_clock"?: NonNullable<Json>,"habit"?: Json | null,"id"?: string,"kind"?: string,"list_id"?: string,"parent_id"?: string | null,"postpone_count"?: number,"priority"?: number,"recurrence"?: Json | null,"row_version"?: number,"scope_id"?: string,"sort_key"?: string,"source"?: Json | null,"start_date"?: string | null,"status"?: string,"time_zone"?: string | null,"title"?: string,"updated_at"?: string
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
                    "archived_at": string | null,"color": string | null,"created_at": string,"created_by": string | null,"deleted_at": string | null,"field_clock": NonNullable<Json>,"icon": string | null,"id": string,"name": string,"row_version": number,"scope_id": string,"sort_key": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"color"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"icon"?: string | null,"id": string,"name": string,"row_version"?: number,"scope_id": string,"sort_key"?: string,"updated_at"?: string
                  }
                  Update: {
                    "archived_at"?: string | null,"color"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"field_clock"?: NonNullable<Json>,"icon"?: string | null,"id"?: string,"name"?: string,"row_version"?: number,"scope_id"?: string,"sort_key"?: string,"updated_at"?: string
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
            "account_secret_get":
{ Args: { "p_account": string }; Returns: string
                           },
"account_secret_set":
{ Args: { "p_account": string,"p_secret": string }; Returns: undefined
                           },
"call_edge_function":
{ Args: { "p_body"?: Json,"p_path": string }; Returns: number
                           },
"can_write_scope":
{ Args: { "p_scope": string }; Returns: boolean
                           },
"claim_push_queue":
{ Args: { "p_limit"?: number }; Returns: {
              "attempts": number,
"body": string | null,
"claimed_at": string | null,
"created_at": string,
"delivered": number | null,
"error": string | null,
"id": string,
"send_at": string,
"sent_at": string | null,
"task_id": string | null,
"title": string,
"url": string | null,
"user_id": string
            }[]
                          SetofOptions: {
        from: "*"
        to: "push_queue"
        isOneToOne: false
        isSetofReturn: true
      } },
"create_integration_task":
{ Args: { "p_tags"?: Json,"p_task": Json,"p_user": string }; Returns: string
                           },
"delete_push_subscription":
{ Args: { "p_endpoint": string }; Returns: undefined
                           },
"has_scope_access":
{ Args: { "p_scope": string }; Returns: boolean
                           },
"inbound_context":
{ Args: { "p_user": string }; Returns: Json
                           },
"pull_changes":
{ Args: { "p_limit"?: number,"p_since"?: Json }; Returns: Json
                           },
"push_changes":
{ Args: { "p_ops": Json }; Returns: Json
                           },
"random_token":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"rotate_inbound_token":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"save_push_subscription":
{ Args: { "p_subscription": Json,"p_user_agent"?: string }; Returns: string
                           },
"server_hlc":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"set_inbound_senders":
{ Args: { "p_senders": (string)[] }; Returns: undefined
                           },
"synced_tables":
{ Args: Record<PropertyKey, never>; Returns: (string)[]
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
