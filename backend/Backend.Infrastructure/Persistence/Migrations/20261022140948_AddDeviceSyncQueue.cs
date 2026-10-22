using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Backend.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddDeviceSyncQueue : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "device_sync_jobs",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Kind = table.Column<int>(type: "integer", nullable: false),
                    Status = table.Column<int>(type: "integer", nullable: false),
                    SyncId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    AccessLevelId = table.Column<Guid>(type: "uuid", nullable: true),
                    CreatedBy = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    StartedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    FinishedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Force = table.Column<bool>(type: "boolean", nullable: false),
                    TotalItems = table.Column<int>(type: "integer", nullable: false),
                    DoneItems = table.Column<int>(type: "integer", nullable: false),
                    FailedItems = table.Column<int>(type: "integer", nullable: false),
                    SkippedItems = table.Column<int>(type: "integer", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_device_sync_jobs", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "device_sync_items",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    JobId = table.Column<Guid>(type: "uuid", nullable: false),
                    DeviceId = table.Column<Guid>(type: "uuid", nullable: false),
                    PersonId = table.Column<Guid>(type: "uuid", nullable: false),
                    EmployeeNo = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Op = table.Column<int>(type: "integer", nullable: false),
                    Status = table.Column<int>(type: "integer", nullable: false),
                    Attempts = table.Column<int>(type: "integer", nullable: false),
                    LastError = table.Column<string>(type: "character varying(1024)", maxLength: 1024, nullable: true),
                    LastAttemptUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    NextAttemptUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    PayloadHash = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_device_sync_items", x => x.Id);
                    table.ForeignKey(
                        name: "FK_device_sync_items_device_sync_jobs_JobId",
                        column: x => x.JobId,
                        principalTable: "device_sync_jobs",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_device_sync_items_JobId_DeviceId_PersonId_Op",
                table: "device_sync_items",
                columns: new[] { "JobId", "DeviceId", "PersonId", "Op" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_device_sync_items_JobId_DeviceId_Status_NextAttemptUtc",
                table: "device_sync_items",
                columns: new[] { "JobId", "DeviceId", "Status", "NextAttemptUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_device_sync_jobs_AccessLevelId",
                table: "device_sync_jobs",
                column: "AccessLevelId");

            migrationBuilder.CreateIndex(
                name: "IX_device_sync_jobs_Status_CreatedUtc",
                table: "device_sync_jobs",
                columns: new[] { "Status", "CreatedUtc" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "device_sync_items");

            migrationBuilder.DropTable(
                name: "device_sync_jobs");
        }
    }
}
