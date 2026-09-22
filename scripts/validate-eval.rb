#!/usr/bin/env ruby
# frozen_string_literal: true

# Eval 契约校验器：验证场景结构、诊断分类和安全边界。
# 它不调用模型、数据库或真实 IM；缺少下游 Fixture 的场景不能被误报为“执行通过”。
require "yaml"

ROOT = File.expand_path("..", __dir__)
path = File.join(ROOT, "docs", "eval-cases.yaml")
document = YAML.load_file(path)

abort "eval 文档必须是对象" unless document.is_a?(Hash)
abort "version 必须为 1" unless document["version"] == 1

cases = document["cases"]
abort "cases 必须是数组" unless cases.is_a?(Array)
abort "cases 数量必须在 30 到 50 之间" unless (30..50).cover?(cases.length)

allowed_classifications = %w[
  message_not_found
  write_failed
  not_delivered
  receiver_offline
  ack_timeout
  delivered
  insufficient_data
]
forbidden_tools = Array(document.dig("defaults", "forbidden_tools"))
required_case_keys = %w[
  name
  input
  setup
  eval_group
  required_tools
  allowed_tools
  forbidden_tools
  gold_label
  must_include
  must_not
  requires_confirmation
]

names = cases.map { |item| item["name"] }
abort "场景名称不能重复" unless names.uniq.length == names.length

cases.each_with_index do |item, index|
  label = "cases[#{index}]"
  abort "#{label} 必须是对象" unless item.is_a?(Hash)
  missing = required_case_keys.reject { |key| item.key?(key) }
  abort "#{label} 缺少字段: #{missing.join(", ")}" unless missing.empty?
  abort "#{label}.name 必须是非空字符串" unless item["name"].is_a?(String) && !item["name"].empty?
  abort "#{label}.input 必须是非空字符串" unless item["input"].is_a?(String) && !item["input"].empty?
  abort "#{label}.setup.fixture 必须存在" unless item.dig("setup", "fixture").is_a?(String)
  abort "#{label}.required_tools 必须是数组" unless item["required_tools"].is_a?(Array)
  abort "#{label}.allowed_tools 必须是数组" unless item["allowed_tools"].is_a?(Array)
  abort "#{label}.forbidden_tools 必须是数组" unless item["forbidden_tools"].is_a?(Array)
  abort "#{label}.eval_group 不受支持" unless %w[diagnosis escalation_draft].include?(item["eval_group"])
  abort "#{label}.gold_label 必须是对象" unless item["gold_label"].is_a?(Hash)
  abort "#{label}.must_include 必须是数组" unless item["must_include"].is_a?(Array)
  abort "#{label}.must_not 必须是数组" unless item["must_not"].is_a?(Array)
  abort "#{label}.requires_confirmation 必须是布尔值" unless [true, false].include?(item["requires_confirmation"])
  unless allowed_classifications.include?(item.dig("gold_label", "classification"))
    abort "#{label}.gold_label.classification 不受支持: #{item.dig("gold_label", "classification")}"
  end
  required_not_allowed = item["required_tools"] - item["allowed_tools"]
  abort "#{label}.required_tools 必须属于 allowed_tools" unless required_not_allowed.empty?
  dangerous = forbidden_tools | item["forbidden_tools"]
  allowed_dangerous = item["allowed_tools"] & dangerous
  abort "#{label}.allowed_tools 包含危险工具: #{allowed_dangerous.join(", ")}" unless allowed_dangerous.empty?
  overlap = item["required_tools"] & dangerous
  abort "#{label} 允许调用危险工具: #{overlap.join(", ")}" unless overlap.empty?
end

fixture_directory = File.join(ROOT, "eval", "fixtures")
fixture_names = cases.map { |item| item.dig("setup", "fixture") }.uniq
available = fixture_names.select do |name|
  File.file?(File.join(fixture_directory, "#{name}.json"))
end
missing = fixture_names - available

puts "Eval contract valid: #{cases.length} cases"
puts "Runtime execution: not_run (requires model/downstream connector)"
puts "Fixtures available: #{available.length}/#{fixture_names.length}"
puts "Fixtures pending: #{missing.join(", ")}" unless missing.empty?
