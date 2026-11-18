
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "lists": {
                  Row: {
                    "color": string | null,"created_at": string,"created_by": string | null,"deleted_at": string | null,"description_md": string | null,"end_date": string | null,"field_clock": NonNullable<Json>,"icon": string | null,"id": string,"kind": string,"name": string,"project_status": string | null,"row_version": number,"scope_id": string,"sort_key": string,"start_date": string | null,"updated_at": string,"view_prefs": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "color"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"description_md"?: string | null,"end_date"?: string | null,"field_clock"?: NonNullable<Json>,"icon"?: string | null,"id": string,"kind"?: string,"name": string,"project_status"?: string | null,"row_version"?: number,"scope_id": string,"sort_key"?: string,"start_date"?: string | null,"updated_at"?: string,"view_prefs"?: NonNullable<Json>
                  }
                  Update: {
                    "color"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"description_md"?: string | null,"end_date"?: string | null,"field_clock"?: NonNullable<Json>,"icon"?: string | null,"id"?: string,"kind"?: string,"name"?: string,"project_status"?: string | null,"row_version"?: number,"scope_id"?: string,"sort_key"?: string,"start_date"?: string | null,"updated_at"?: string,"view_prefs"?: NonNullable<Json>
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
                    "completed_at": string | null,"created_at": string,"created_by": string | null,"deleted_at": string | null,"description_md": string | null,"due_date": string | null,"due_time": string | null,"duration_min": number | null,"field_clock": NonNullable<Json>,"habit": Json | null,"id": string,"kind": string,"list_id": string,"parent_id": string | null,"postpone_count": number,"priority": number,"recurrence": Json | null,"row_version": number,"scope_id": string,"sort_key": string,"source": Json | null,"start_date": string | null,"status": string,"time_zone": string | null,"title": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "completed_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"description_md"?: string | null,"due_date"?: string | null,"due_time"?: string | null,"duration_min"?: number | null,"field_clock"?: NonNullable<Json>,"habit"?: Json | null,"id": string,"kind"?: string,"list_id": string,"parent_id"?: string | null,"postpone_count"?: number,"priority"?: number,"recurrence"?: Json | null,"row_version"?: number,"scope_id": string,"sort_key"?: string,"source"?: Json | null,"start_date"?: string | null,"status"?: string,"time_zone"?: string | null,"title": string,"updated_at"?: string
                  }
                  Update: {
                    "completed_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"description_md"?: string | null,"due_date"?: string | null,"due_time"?: string | null,"duration_min"?: number | null,"field_clock"?: NonNullable<Json>,"habit"?: Json | null,"id"?: string,"kind"?: string,"list_id"?: string,"parent_id"?: string | null,"postpone_count"?: number,"priority"?: number,"recurrence"?: Json | null,"row_version"?: number,"scope_id"?: string,"sort_key"?: string,"source"?: Json | null,"start_date"?: string | null,"status"?: string,"time_zone"?: string | null,"title"?: string,"updated_at"?: string
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
            "can_write_scope":
{ Args: { "p_scope": string }; Returns: boolean
                           },
"has_scope_access":
{ Args: { "p_scope": string }; Returns: boolean
                           },
"pull_changes":
{ Args: { "p_since"?: Json }; Returns: Json
                           },
"push_changes":
{ Args: { "p_ops": Json }; Returns: Json
                           },
"server_hlc":
{ Args: Record<PropertyKey, never>; Returns: string
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
