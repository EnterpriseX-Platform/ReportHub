package io.reporthub.reportstudio.domain;

import jakarta.persistence.*;
import java.time.OffsetDateTime;

/**
 * User-defined data scope of a check group, as opposed to the scope inferred from members' SQL.
 *
 * <p>{@link #source} holds either a bare table name or a full SELECT, so a group that checks data
 * joined from several tables can define its scope without a staging table.
 *
 * <p>Rules refer to the scope via {@code $SCOPE}, replaced at run time by a subquery with the
 * shared conditions applied.
 */
@Entity
@Table(name = "check_group_scope")
public class CheckGroupScope {

    /** Group name (primary key); "" = ungrouped. */
    @Id
    @Column(length = 200, nullable = false)
    private String folder;

    /** Table name or a full SELECT. */
    @Column(nullable = false, columnDefinition = "text")
    private String source;

    /** Shared conditions, one per line, joined with AND when building $SCOPE. */
    @Column(columnDefinition = "text")
    private String conditions;

    @Column(name = "datasource_id", length = 80)
    private String datasourceId;

    @Column(name = "updated_at")
    private OffsetDateTime updatedAt;

    @Column(name = "updated_by", length = 120)
    private String updatedBy;

    public String getFolder() { return folder; }
    public void setFolder(String folder) { this.folder = folder; }
    public String getSource() { return source; }
    public void setSource(String source) { this.source = source; }
    public String getConditions() { return conditions; }
    public void setConditions(String conditions) { this.conditions = conditions; }
    public String getDatasourceId() { return datasourceId; }
    public void setDatasourceId(String datasourceId) { this.datasourceId = datasourceId; }
    public OffsetDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(OffsetDateTime updatedAt) { this.updatedAt = updatedAt; }
    public String getUpdatedBy() { return updatedBy; }
    public void setUpdatedBy(String updatedBy) { this.updatedBy = updatedBy; }
}
