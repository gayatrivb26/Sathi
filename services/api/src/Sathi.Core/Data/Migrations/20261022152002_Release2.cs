using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Sathi.Core.Data.Migrations
{
    /// <inheritdoc />
    public partial class Release2 : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateOnly>(
                name: "date_of_birth",
                schema: "app",
                table: "users",
                type: "date",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "guardian_consent_at",
                schema: "app",
                table: "users",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "guardian_consent_status",
                schema: "app",
                table: "users",
                type: "text",
                nullable: false,
                defaultValue: "not_required");

            migrationBuilder.AddColumn<string>(
                name: "guardian_email_normalized",
                schema: "app",
                table: "users",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "is_minor",
                schema: "app",
                table: "users",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "idempotency_key",
                schema: "app",
                table: "documents",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "visibility",
                schema: "app",
                table: "courses",
                type: "text",
                nullable: false,
                defaultValue: "public");

            migrationBuilder.CreateTable(
                name: "classes",
                schema: "app",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    course_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "text", nullable: false),
                    description = table.Column<string>(type: "text", nullable: true),
                    join_code = table.Column<string>(type: "text", nullable: false),
                    join_enabled = table.Column<bool>(type: "boolean", nullable: false, defaultValue: true),
                    created_by = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    archived_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_classes", x => x.id);
                    table.ForeignKey(
                        name: "fk_classes_courses_course_id",
                        column: x => x.course_id,
                        principalSchema: "app",
                        principalTable: "courses",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "course_instructors",
                schema: "app",
                columns: table => new
                {
                    course_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    role = table.Column<string>(type: "text", nullable: false),
                    added_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_course_instructors", x => new { x.course_id, x.user_id });
                    table.ForeignKey(
                        name: "fk_course_instructors_courses_course_id",
                        column: x => x.course_id,
                        principalSchema: "app",
                        principalTable: "courses",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_course_instructors_users_user_id",
                        column: x => x.user_id,
                        principalSchema: "app",
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "guardian_consents",
                schema: "app",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    guardian_email_normalized = table.Column<string>(type: "text", nullable: false),
                    token_hash = table.Column<string>(type: "text", nullable: false),
                    policy_version = table.Column<string>(type: "text", nullable: false),
                    requested_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    expires_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    decided_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    decision = table.Column<string>(type: "text", nullable: true),
                    ip_hash = table.Column<string>(type: "text", nullable: true),
                    user_agent_hash = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_guardian_consents", x => x.id);
                    table.ForeignKey(
                        name: "fk_guardian_consents_users_user_id",
                        column: x => x.user_id,
                        principalSchema: "app",
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "staff_invites",
                schema: "app",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    email_normalized = table.Column<string>(type: "text", nullable: false),
                    role = table.Column<string>(type: "text", nullable: false),
                    course_id = table.Column<Guid>(type: "uuid", nullable: true),
                    token_hash = table.Column<string>(type: "text", nullable: false),
                    invited_by = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    expires_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    accepted_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    accepted_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    revoked_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_staff_invites", x => x.id);
                    table.ForeignKey(
                        name: "fk_staff_invites_courses_course_id",
                        column: x => x.course_id,
                        principalSchema: "app",
                        principalTable: "courses",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "class_invites",
                schema: "app",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    class_id = table.Column<Guid>(type: "uuid", nullable: false),
                    email_normalized = table.Column<string>(type: "text", nullable: false),
                    token_hash = table.Column<string>(type: "text", nullable: false),
                    invited_by = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    expires_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    accepted_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    accepted_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    revoked_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_class_invites", x => x.id);
                    table.ForeignKey(
                        name: "fk_class_invites_classes_class_id",
                        column: x => x.class_id,
                        principalSchema: "app",
                        principalTable: "classes",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "class_members",
                schema: "app",
                columns: table => new
                {
                    class_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    joined_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    joined_via = table.Column<string>(type: "text", nullable: false),
                    removed_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_class_members", x => new { x.class_id, x.user_id });
                    table.ForeignKey(
                        name: "fk_class_members_classes_class_id",
                        column: x => x.class_id,
                        principalSchema: "app",
                        principalTable: "classes",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_class_members_users_user_id",
                        column: x => x.user_id,
                        principalSchema: "app",
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_documents_owner_user_id_idempotency_key",
                schema: "app",
                table: "documents",
                columns: new[] { "owner_user_id", "idempotency_key" },
                unique: true,
                filter: "idempotency_key IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "ix_class_invites_class_id_email_normalized",
                schema: "app",
                table: "class_invites",
                columns: new[] { "class_id", "email_normalized" },
                unique: true,
                filter: "accepted_at IS NULL AND revoked_at IS NULL");

            migrationBuilder.CreateIndex(
                name: "ix_class_invites_token_hash",
                schema: "app",
                table: "class_invites",
                column: "token_hash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_class_members_user_id",
                schema: "app",
                table: "class_members",
                column: "user_id");

            migrationBuilder.CreateIndex(
                name: "ix_classes_course_id",
                schema: "app",
                table: "classes",
                column: "course_id");

            migrationBuilder.CreateIndex(
                name: "ix_classes_join_code",
                schema: "app",
                table: "classes",
                column: "join_code",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_course_instructors_user_id",
                schema: "app",
                table: "course_instructors",
                column: "user_id");

            migrationBuilder.CreateIndex(
                name: "ix_guardian_consents_token_hash",
                schema: "app",
                table: "guardian_consents",
                column: "token_hash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_guardian_consents_user_id",
                schema: "app",
                table: "guardian_consents",
                column: "user_id");

            migrationBuilder.CreateIndex(
                name: "ix_staff_invites_course_id",
                schema: "app",
                table: "staff_invites",
                column: "course_id");

            migrationBuilder.CreateIndex(
                name: "ix_staff_invites_email_normalized",
                schema: "app",
                table: "staff_invites",
                column: "email_normalized");

            migrationBuilder.CreateIndex(
                name: "ix_staff_invites_token_hash",
                schema: "app",
                table: "staff_invites",
                column: "token_hash",
                unique: true);

            // Contract §11.1: every course with a creator gets that creator as its owner.
            migrationBuilder.Sql("""
                INSERT INTO app.course_instructors (course_id, user_id, role, added_at)
                SELECT c.id, c.created_by, 'owner', now()
                FROM app.courses c
                WHERE c.created_by IS NOT NULL
                  AND EXISTS (SELECT 1 FROM app.users u WHERE u.id = c.created_by)
                ON CONFLICT (course_id, user_id) DO NOTHING;
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "class_invites",
                schema: "app");

            migrationBuilder.DropTable(
                name: "class_members",
                schema: "app");

            migrationBuilder.DropTable(
                name: "course_instructors",
                schema: "app");

            migrationBuilder.DropTable(
                name: "guardian_consents",
                schema: "app");

            migrationBuilder.DropTable(
                name: "staff_invites",
                schema: "app");

            migrationBuilder.DropTable(
                name: "classes",
                schema: "app");

            migrationBuilder.DropIndex(
                name: "ix_documents_owner_user_id_idempotency_key",
                schema: "app",
                table: "documents");

            migrationBuilder.DropColumn(
                name: "date_of_birth",
                schema: "app",
                table: "users");

            migrationBuilder.DropColumn(
                name: "guardian_consent_at",
                schema: "app",
                table: "users");

            migrationBuilder.DropColumn(
                name: "guardian_consent_status",
                schema: "app",
                table: "users");

            migrationBuilder.DropColumn(
                name: "guardian_email_normalized",
                schema: "app",
                table: "users");

            migrationBuilder.DropColumn(
                name: "is_minor",
                schema: "app",
                table: "users");

            migrationBuilder.DropColumn(
                name: "idempotency_key",
                schema: "app",
                table: "documents");

            migrationBuilder.DropColumn(
                name: "visibility",
                schema: "app",
                table: "courses");
        }
    }
}
