package com.kalamos.notebook.storage

import org.json.JSONArray
import org.json.JSONObject

// Points carry only x,y — pressure/timestamp were stored historically but never read by any
// renderer (web canvas or native surface both use x,y + per-stroke width), so they were ~3x dead
// weight in the payload that crosses the bridge on load. Coords are rounded to integer pixels
// (sub-pixel is irrelevant at e-ink DPI, and both renderers round anyway). Old files with p/t are
// read fine (fields ignored) and shrink on next save.
data class StrokePoint(val x: Float, val y: Float) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("x", Math.round(x))
        put("y", Math.round(y))
    }

    companion object {
        fun fromJson(obj: JSONObject): StrokePoint = StrokePoint(
            x = obj.getDouble("x").toFloat(),
            y = obj.getDouble("y").toFloat()
        )
    }
}

data class Stroke(
    val id: String,
    val tool: String,
    val color: String,
    val width: Float,
    val points: List<StrokePoint>
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("tool", tool)
        put("color", color)
        put("width", width.toDouble())
        put("points", JSONArray(points.map { it.toJson() }))
    }

    companion object {
        fun fromJson(obj: JSONObject): Stroke = Stroke(
            id = obj.getString("id"),
            tool = obj.optString("tool", "pen"),
            color = obj.optString("color", "#111111"),
            width = obj.getDouble("width").toFloat(),
            points = obj.getJSONArray("points").let { arr ->
                (0 until arr.length()).map { StrokePoint.fromJson(arr.getJSONObject(it)) }
            }
        )
    }
}

data class Template(
    val type: String,
    val spacing: Int,
    val margin: Int
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("type", type)
        put("spacing", spacing)
        put("margin", margin)
    }

    companion object {
        fun fromJson(obj: JSONObject): Template = Template(
            type = obj.getString("type"),
            spacing = obj.getInt("spacing"),
            margin = obj.getInt("margin")
        )

        val DEFAULT = Template("blank", 32, 72)
    }
}

data class Page(
    val pageId: String,
    val template: Template,
    val strokes: List<Stroke>
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("pageId", pageId)
        put("template", template.toJson())
        put("strokes", JSONArray(strokes.map { it.toJson() }))
    }

    companion object {
        fun fromJson(obj: JSONObject): Page = Page(
            pageId = obj.getString("pageId"),
            template = Template.fromJson(obj.getJSONObject("template")),
            strokes = obj.getJSONArray("strokes").let { arr ->
                (0 until arr.length()).map { Stroke.fromJson(arr.getJSONObject(it)) }
            }
        )
    }
}

data class Notebook(
    val notebookId: String,
    val title: String,
    val folderId: String,
    val createdAt: String,
    val updatedAt: String,
    val defaultTemplate: Template,
    val pages: List<Page>
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("notebookId", notebookId)
        put("title", title)
        put("folderId", folderId)
        put("createdAt", createdAt)
        put("updatedAt", updatedAt)
        put("defaultTemplate", defaultTemplate.toJson())
        put("pages", JSONArray(pages.map { it.toJson() }))
    }

    companion object {
        fun fromJson(obj: JSONObject): Notebook = Notebook(
            notebookId = obj.getString("notebookId"),
            title = obj.optString("title", "Notebook"),
            folderId = obj.optString("folderId", ""),
            createdAt = obj.optString("createdAt", ""),
            updatedAt = obj.optString("updatedAt", ""),
            defaultTemplate = if (obj.has("defaultTemplate")) Template.fromJson(obj.getJSONObject("defaultTemplate")) else Template.DEFAULT,
            pages = obj.getJSONArray("pages").let { arr ->
                (0 until arr.length()).map { Page.fromJson(arr.getJSONObject(it)) }
            }
        )
    }
}

data class FolderInfo(
    val folderId: String,
    val name: String,
    val createdAt: String
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("folderId", folderId)
        put("name", name)
        put("createdAt", createdAt)
    }

    companion object {
        fun fromJson(obj: JSONObject): FolderInfo = FolderInfo(
            folderId = obj.getString("folderId"),
            name = obj.optString("name", "Unnamed"),
            createdAt = obj.optString("createdAt", "")
        )
    }
}

data class NotebookInfo(
    val notebookId: String,
    val title: String,
    val folderId: String,
    val createdAt: String,
    val updatedAt: String,
    val defaultTemplate: Template
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("notebookId", notebookId)
        put("title", title)
        put("folderId", folderId)
        put("createdAt", createdAt)
        put("updatedAt", updatedAt)
        put("defaultTemplate", defaultTemplate.toJson())
    }

    companion object {
        fun fromJson(obj: JSONObject): NotebookInfo = NotebookInfo(
            notebookId = obj.getString("notebookId"),
            title = obj.optString("title", "Notebook"),
            folderId = obj.optString("folderId", ""),
            createdAt = obj.optString("createdAt", ""),
            updatedAt = obj.optString("updatedAt", ""),
            defaultTemplate = if (obj.has("defaultTemplate")) Template.fromJson(obj.getJSONObject("defaultTemplate")) else Template.DEFAULT
        )
    }
}

data class LibraryIndex(
    val version: Int,
    val notebooks: List<NotebookInfo>,
    val folders: List<FolderInfo>
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("version", version)
        put("notebooks", JSONArray(notebooks.map { it.toJson() }))
        put("folders", JSONArray(folders.map { it.toJson() }))
    }

    companion object {
        fun fromJson(obj: JSONObject): LibraryIndex = LibraryIndex(
            version = obj.optInt("version", 1),
            notebooks = obj.getJSONArray("notebooks").let { arr ->
                (0 until arr.length()).map { NotebookInfo.fromJson(arr.getJSONObject(it)) }
            },
            folders = if (obj.has("folders")) obj.getJSONArray("folders").let { arr ->
                (0 until arr.length()).map { FolderInfo.fromJson(arr.getJSONObject(it)) }
            } else emptyList()
        )

        val EMPTY = LibraryIndex(1, emptyList(), emptyList())
    }
}
