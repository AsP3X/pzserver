<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::create('pvp_violations', function (Blueprint $table) {
            $table->id();
            $table->string('attacker');
            $table->string('victim');
            $table->string('zone_id');
            $table->string('zone_name');
            $table->integer('attacker_x')->nullable();
            $table->integer('attacker_y')->nullable();
            $table->integer('strike_number');
            $table->string('status')->default('pending'); // pending, dismissed, actioned
            $table->text('resolution_note')->nullable();
            $table->string('resolved_by')->nullable();
            $table->timestamp('occurred_at');
            $table->timestamp('resolved_at')->nullable();
            $table->timestamps();

            $table->index('status');
            $table->index('attacker');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('pvp_violations');
    }
};
